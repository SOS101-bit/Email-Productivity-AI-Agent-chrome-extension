"""
Gmail API client for fetching emails.
Uses OAuth token passed from the Chrome extension.
"""

import base64
import re
from typing import List, Dict, Optional

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from bs4 import BeautifulSoup


# Must match the scopes declared in manifest.json oauth2.scopes
_SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.compose",
]


def _make_credentials(gmail_token: str) -> Credentials:
    """
    Build a Credentials object from a raw OAuth token.

    The scopes must be passed explicitly — without them Google treats
    the credential as unverified and triggers re-authentication on every call.
    """
    return Credentials(
        token=gmail_token,
        scopes=_SCOPES,
    )


def fetch_emails_from_sender(
    sender_email: str,
    gmail_token: str,
    max_results: int = 50,
) -> List[Dict[str, str]]:
    """
    Fetch emails from a specific sender using the Gmail API.

    Returns a list of dicts: { subject, body, date }
    """
    try:
        creds   = _make_credentials(gmail_token)
        service = build("gmail", "v1", credentials=creds)

        results = service.users().messages().list(
            userId="me",
            q=f"from:{sender_email}",
            maxResults=max_results,
        ).execute()

        messages = results.get("messages", [])
        if not messages:
            return []

        emails = []
        for msg in messages:
            try:
                message = service.users().messages().get(
                    userId="me",
                    id=msg["id"],
                    format="full",
                ).execute()

                headers = {
                    h["name"]: h["value"]
                    for h in message.get("payload", {}).get("headers", [])
                }

                body = extract_body(message)
                if body and len(body.strip()) > 10:
                    emails.append({
                        "subject": headers.get("Subject", ""),
                        "body":    body,
                        "date":    headers.get("Date", ""),
                    })

            except Exception as e:
                print(f"[Gmail] Error fetching message {msg['id']}: {e}")
                continue

        print(f"[Gmail] Fetched {len(emails)} emails from {sender_email}")
        return emails

    except HttpError as e:
        print(f"[Gmail] API error: {e}")
        if e.resp.status == 401:
            raise Exception("Gmail token expired or invalid — user must re-authenticate")
        raise
    except Exception as e:
        print(f"[Gmail] Unexpected error: {e}")
        raise


# ─── Body extraction ──────────────────────────────────────────────────────────

def extract_body(message: Dict) -> str:
    """
    Recursively walk the MIME tree to extract plain text.
    Handles nested multipart/mixed, multipart/alternative, etc.
    Falls back to HTML → text conversion if no plain text part exists.
    """
    payload = message.get("payload", {})
    plain, html = _walk_parts(payload)

    if plain:
        return clean_text(plain)
    if html:
        return clean_text(html_to_text(html))
    return ""


def _walk_parts(part: Dict):
    """
    Recursively walk MIME parts.
    Returns (plain_text, html_text) — whichever is found first.
    """
    mime = part.get("mimeType", "")
    plain = ""
    html  = ""

    if mime == "text/plain":
        plain = _decode_data(part.get("body", {}).get("data", ""))

    elif mime == "text/html":
        html = _decode_data(part.get("body", {}).get("data", ""))

    elif mime.startswith("multipart/"):
        for subpart in part.get("parts", []):
            sub_plain, sub_html = _walk_parts(subpart)
            if sub_plain and not plain:
                plain = sub_plain
            if sub_html and not html:
                html = sub_html
            # Stop early if we have plain text (preferred)
            if plain:
                break

    return plain, html


def _decode_data(data: str) -> str:
    """Base64url-decode a Gmail body data field."""
    if not data:
        return ""
    try:
        return base64.urlsafe_b64decode(data).decode("utf-8", errors="ignore")
    except Exception:
        return ""


# ─── Text cleaning ────────────────────────────────────────────────────────────

def html_to_text(html: str) -> str:
    try:
        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "noscript"]):
            tag.decompose()
        return soup.get_text(separator="\n")
    except Exception:
        return re.sub(r"<[^>]+>", "", html)


def clean_text(text: str) -> str:
    """Collapse blank lines and strip trailing whitespace."""
    lines = [line.strip() for line in text.splitlines()]
    # Remove consecutive blank lines
    cleaned = []
    prev_blank = False
    for line in lines:
        is_blank = not line
        if is_blank and prev_blank:
            continue
        cleaned.append(line)
        prev_blank = is_blank
    return "\n".join(cleaned).strip()


if __name__ == "__main__":
    print("Gmail client loaded. Use fetch_emails_from_sender(sender_email, gmail_token).")