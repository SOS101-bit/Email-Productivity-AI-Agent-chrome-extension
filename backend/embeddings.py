"""
Embeddings module using sentence-transformers (local, no API key needed).
Runs entirely on your machine — faster than cloud for embeddings.
"""

import os
from typing import List
from dotenv import load_dotenv
load_dotenv()

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "all-MiniLM-L6-v2")
EMBEDDING_DIM   = 384   # all-MiniLM-L6-v2 output dimension

# Load model once at module level — not on every call
_model = None

def _get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        print(f"[Embeddings] Loading local model: {EMBEDDING_MODEL}")
        _model = SentenceTransformer(EMBEDDING_MODEL)
        print(f"[Embeddings] Model loaded ✓")
    return _model


# ─── Single embed (sync) ──────────────────────────────────────────────────────

def embed(text: str) -> List[float]:
    """Embed a single text using local sentence-transformers."""
    model = _get_model()
    embedding = model.encode(text, normalize_embeddings=True)
    return embedding.tolist()


# ─── Batch embed ──────────────────────────────────────────────────────────────

def batch_embed(texts: List[str], batch_size: int = 32) -> List[List[float]]:
    """
    Embed a list of texts in one shot using sentence-transformers.
    Much faster than calling embed() in a loop — the model processes
    the entire batch in a single forward pass.
    """
    model = _get_model()
    embeddings = model.encode(
        texts,
        batch_size=batch_size,
        normalize_embeddings=True,
        show_progress_bar=len(texts) > 50,
    )
    return [e.tolist() for e in embeddings]


if __name__ == "__main__":
    test_texts = ["Hello world", "This is a test", "Embedding test"]
    print(f"Testing batch embed with {len(test_texts)} texts...")
    embeddings = batch_embed(test_texts)
    print(f"Got {len(embeddings)} embeddings, dim={len(embeddings[0])}")
    print(f"First 5 values: {embeddings[0][:5]}")