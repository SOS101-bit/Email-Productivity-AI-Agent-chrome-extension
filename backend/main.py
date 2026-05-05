"""
Reply with AI - FastAPI Backend
Main application entry point.
"""

import os
import json
import asyncio
from typing import Optional
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import httpx

from rag import ingest_emails, retrieve_context, collection_exists
from gmail_client import fetch_emails_from_sender
from embeddings import embed
from dotenv import load_dotenv
load_dotenv()

# ─── Configuration ────────────────────────────────────────────────────────────

OLLAMA_BASE_URL = os.getenv("OLLAMA_BASE_URL", "https://ollama.com")
OLLAMA_MODEL    = os.getenv("OLLAMA_MODEL", "qwen3.5")
OLLAMA_API_KEY  = os.getenv("OLLAMA_API_KEY","")

# Tracks which senders are currently being ingested so we don't double-ingest
_ingesting: set[str] = set()


# ─── Pydantic models ──────────────────────────────────────────────────────────

class IngestRequest(BaseModel):
    sender_email: str
    gmail_token: str
    max_emails: Optional[int] = 100


class ReplyRequest(BaseModel):
    sender_email: str
    thread_text: str
    gmail_token: str


# ─── Prompt ───────────────────────────────────────────────────────────────────

def build_prompt(context: str, thread_text: str) -> str:
    ctx_block = context.strip() if context else "No past email context available."
    # Trim thread_text to last 2000 chars — older content rarely helps
    thread_trimmed = thread_text.strip()[-2000:]
    return f"""You are a professional email assistant. Write a concise reply to the email thread below.

PAST EMAIL CONTEXT WITH THIS SENDER:
{ctx_block}

CURRENT EMAIL THREAD:
{thread_trimmed}

Instructions:
- Read the tone carefully — if it's casual (like "Hi", "Hey", "sup"), reply casually. If it's formal, reply formally.
- Match the tone of the conversation (formal or casual).
- Be concise — no unnecessary filler.
- Keep it short and natural — no filler phrases like "I hope this email finds you well".
- DO NOT ADD PLACEHOLDER TEXT LIKE [YOUR NAME].
- Start the reply directly, no preamble.
- Never start with "I received your message" or "Thank you for reaching out".
- Just reply naturally as a human would.

Reply:"""


# ─── Ollama streaming (fully async) ──────────────────────────────────────────

async def stream_ollama(prompt: str):
    """
    Async generator that streams tokens from Ollama one by one.
    Uses httpx.AsyncClient so it never blocks the event loop.
    """
    url = f"{OLLAMA_BASE_URL}/api/generate"
    headers = {}
    if OLLAMA_API_KEY:
        headers["Authorization"] = f"Bearer {OLLAMA_API_KEY}"

    payload = {
        "model": OLLAMA_MODEL,
        "prompt": prompt,
        "stream": True,
        "think": False,
        "options": {
            "temperature": 0.7,
            "num_predict": 1024,   # cap output length for speed
        }
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream("POST", url, json=payload, headers=headers) as response:
            if response.status_code != 200:
                body = await response.aread()
                raise HTTPException(
                    status_code=502,
                    detail=f"Ollama error {response.status_code}: {body.decode()[:200]}"
                )
            async for line in response.aiter_lines():
                if not line:
                    continue
                try:
                    data = json.loads(line)
                    print(f"[Ollama RAW] {json.dumps(data)[:200]}", flush=True)  # ← add this
                    token = data.get("response", "")
                    if token:
                        yield token
                    if data.get("done"):
                        break
                except json.JSONDecodeError:
                    continue


# ─── Background ingestion ─────────────────────────────────────────────────────

async def ingest_in_background(sender_email: str, gmail_token: str):
    """
    Fetch and ingest emails in a background task.
    Skips if already ingesting for this sender.
    """
    if sender_email in _ingesting:
        return
    _ingesting.add(sender_email)
    try:
        print(f"[BG] Starting ingestion for {sender_email}")
        # Run blocking IO in a thread so we don't block the event loop
        emails = await asyncio.to_thread(
            fetch_emails_from_sender,
            sender_email=sender_email,
            gmail_token=gmail_token,
            max_results=50           # 50 is plenty; 100 is overkill and slow
        )
        if emails:
            await asyncio.to_thread(ingest_emails, sender_email, emails)
            print(f"[BG] Ingested {len(emails)} emails for {sender_email}")
        else:
            print(f"[BG] No emails found for {sender_email}")
    except Exception as e:
        print(f"[BG] Ingestion error for {sender_email}: {e}")
    finally:
        _ingesting.discard(sender_email)


# ─── App ──────────────────────────────────────────────────────────────────────

@asynccontextmanager
async def lifespan(app: FastAPI):
    print(f"Starting Reply with AI | model={OLLAMA_MODEL} | ollama={OLLAMA_BASE_URL}")
    yield
    print("Shutting down.")


app = FastAPI(title="Reply with AI", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ─── Endpoints ────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/ingest")
async def ingest_endpoint(request: IngestRequest):
    """Manually trigger email ingestion for a sender."""
    try:
        emails = await asyncio.to_thread(
            fetch_emails_from_sender,
            sender_email=request.sender_email,
            gmail_token=request.gmail_token,
            max_results=request.max_emails
        )
        if not emails:
            return {"status": "warning", "message": "No emails found", "chunks_ingested": 0}

        chunks = await asyncio.to_thread(ingest_emails, request.sender_email, emails)
        return {"status": "success", "emails_fetched": len(emails), "chunks_ingested": chunks}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/reply")
async def draft_reply(request: ReplyRequest):
    """
    Stream an AI-generated reply.

    Flow:
    1. If sender not indexed → kick off background ingestion (non-blocking)
    2. Retrieve whatever context is already available
    3. Start streaming Ollama tokens immediately — no waiting
    """
    sender   = request.sender_email
    token    = request.gmail_token
    thread   = request.thread_text

    # Kick off ingestion in background if needed — does NOT block the reply
    already_indexed = await asyncio.to_thread(collection_exists, sender)
    if not already_indexed and sender not in _ingesting:
        asyncio.create_task(ingest_in_background(sender, token))

    # Retrieve context (fast — just a vector DB query)
    context = ""
    if already_indexed:
        context = await asyncio.to_thread(
            retrieve_context,
            sender_email=sender,
            query_text=thread,
            top_k=4          # 4 chunks is enough; 5 adds latency
        )

    prompt = build_prompt(context, thread)

    async def generate():
        try:
            full = ""
            async for token in stream_ollama(prompt):
                full += token
                print(f"[Stream] Token: {repr(token[:50])}", flush=True)
                yield token
            print(f"[Stream] Total yielded: {len(full)}", flush=True)
        except Exception as e:
            print(f"[Stream] Error: {e}")
            yield f"\n\n[Error generating reply: {e}]"

    return StreamingResponse(generate(), media_type="text/plain")


@app.get("/stats/{sender_email}")
async def stats(sender_email: str):
    from rag import get_collection_stats
    return await asyncio.to_thread(get_collection_stats, sender_email)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000, reload=False)