"""
RAG module using ChromaDB for vector storage and retrieval.
"""

import hashlib
from typing import List, Dict
import tiktoken
import chromadb

from embeddings import embed, batch_embed


# ─── ChromaDB client (singleton) ─────────────────────────────────────────────

CHROMA_PERSIST_DIR = "./chroma_db"
_chroma_client = chromadb.PersistentClient(path=CHROMA_PERSIST_DIR)


# ─── Tokenizer (singleton — don't re-init on every call) ─────────────────────

def _get_tokenizer():
    try:
        return tiktoken.get_encoding("cl100k_base")
    except Exception:
        return tiktoken.encoding_for_model("gpt-3.5-turbo")

_TOKENIZER = _get_tokenizer()


# ─── Helpers ──────────────────────────────────────────────────────────────────

def get_collection_name(sender_email: str) -> str:
    """MD5-hash the email to create a valid ChromaDB collection name."""
    return "sender_" + hashlib.md5(sender_email.encode()).hexdigest()[:16]


def get_or_create_collection(sender_email: str):
    return _chroma_client.get_or_create_collection(name=get_collection_name(sender_email))


# ─── Chunking ─────────────────────────────────────────────────────────────────

def chunk_text(text: str, chunk_tokens: int = 300, overlap_tokens: int = 50) -> List[str]:
    """
    Split text into overlapping token-based chunks.

    Fixes vs original:
    - Renamed local variable `chunk_text` → `decoded` to avoid shadowing the function.
    - Tokenizer is reused from module-level singleton instead of re-initialised per call.
    """
    tokenizer = _TOKENIZER
    paragraphs = text.split("\n\n")

    result: List[str] = []
    current_tokens: List[int] = []

    def flush():
        if current_tokens:
            result.append(tokenizer.decode(current_tokens))

    for para in paragraphs:
        para_tokens = tokenizer.encode(para)
        para_len = len(para_tokens)

        if para_len > chunk_tokens:
            # Flush whatever we have first
            flush()
            current_tokens = []

            # Slide a window over the large paragraph
            step = chunk_tokens - overlap_tokens
            for i in range(0, para_len, step):
                window = para_tokens[i: i + chunk_tokens]
                decoded = tokenizer.decode(window)   # ← fixed: was `chunk_text` (shadows fn)
                result.append(decoded)

        elif len(current_tokens) + para_len <= chunk_tokens:
            current_tokens.extend(para_tokens)

        else:
            flush()
            # Keep overlap from end of previous chunk
            overlap = current_tokens[-overlap_tokens:] if overlap_tokens else []
            current_tokens = overlap + para_tokens

    flush()

    # Drop trivially short chunks
    return [c for c in result if len(c.strip()) >= 20]


# ─── Ingestion ────────────────────────────────────────────────────────────────

def ingest_emails(sender_email: str, emails: List[Dict[str, str]]) -> int:
    """
    Chunk and embed emails, then upsert into ChromaDB.
    Returns the number of chunks ingested.
    """
    collection = get_or_create_collection(sender_email)

    all_chunks:    List[str]  = []
    all_metadatas: List[Dict] = []
    all_ids:       List[str]  = []

    for email_idx, email in enumerate(emails):
        text = f"Subject: {email.get('subject', '')}\n\n{email.get('body', '')}"
        chunks = chunk_text(text)

        for chunk_idx, chunk in enumerate(chunks):
            all_chunks.append(chunk)
            all_metadatas.append({
                "sender":    sender_email,
                "date":      email.get("date", ""),
                "subject":   email.get("subject", ""),
                "email_idx": email_idx,
                "chunk_idx": chunk_idx,
            })
            all_ids.append(f"{email_idx}_{chunk_idx}")

    if not all_chunks:
        return 0

    print(f"[RAG] Embedding {len(all_chunks)} chunks for {sender_email}…")
    embeddings = batch_embed(all_chunks)

    collection.upsert(
        ids=all_ids,
        embeddings=embeddings,
        metadatas=all_metadatas,
        documents=all_chunks,
    )

    print(f"[RAG] Ingested {len(all_chunks)} chunks for {sender_email}")
    return len(all_chunks)


# ─── Retrieval ────────────────────────────────────────────────────────────────

def retrieve_context(sender_email: str, query_text: str, top_k: int = 4) -> str:
    """
    Embed the query and retrieve the top-k most relevant chunks.
    Returns a formatted string ready to drop into the prompt.
    """
    collection = get_or_create_collection(sender_email)

    if collection.count() == 0:
        return ""

    query_embedding = embed(query_text)

    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=min(top_k, collection.count()),
        include=["documents", "metadatas"],
    )

    docs      = results.get("documents", [[]])[0]
    metadatas = results.get("metadatas", [[]])[0]

    if not docs:
        return ""

    chunks = []
    for doc, meta in zip(docs, metadatas):
        header = f"[{meta.get('date', 'unknown date')} | {meta.get('subject', 'no subject')}]"
        chunks.append(f"{header}\n{doc}")

    return "\n\n".join(chunks)


# ─── Utility ──────────────────────────────────────────────────────────────────

def collection_exists(sender_email: str) -> bool:
    """Return True if the sender has at least one indexed chunk."""
    try:
        return get_or_create_collection(sender_email).count() > 0
    except Exception:
        return False


def get_collection_stats(sender_email: str) -> Dict:
    collection = get_or_create_collection(sender_email)
    count = collection.count()
    return {
        "exists":          count > 0,
        "document_count":  count,
        "collection_name": get_collection_name(sender_email),
    }