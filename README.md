# Reply with AI

A Chrome extension (Manifest V3) that integrates with Gmail and uses a FastAPI + RAG backend to draft email replies. Uses Qwen 3.5 Cloud via Ollama for inference.

## Features

- **AI-powered reply drafts**: Generate professional email replies using Qwen 3.5 Cloud
- **RAG-based context**: Retrieves relevant information from past emails with the same sender
- **Seamless Gmail integration**: Works directly within Gmail's interface
- **Streaming responses**: See replies generated word-by-word in real-time

## Project Structure

```
reply-with-ai/
├── extension/           # Chrome MV3 extension
│   ├── manifest.json
│   ├── content_script.js
│   ├── background.js
│   ├── sidebar.html
│   ├── sidebar.js
│   └── styles.css
├── backend/             # FastAPI backend
│   ├── main.py
│   ├── rag.py
│   ├── gmail_client.py
│   ├── embeddings.py
│   ├── requirements.txt
│   └── .env.example
└── README.md
```

## Prerequisites

1. **Chrome browser** (or any Chromium-based browser)

2. **Ollama installed** - Download from https://ollama.ai

3. **Qwen 3.5 Cloud API Key** - Get your API key from Ollama Cloud

4. **Python 3.10+** for the backend

## Backend Setup

1. **Navigate to the backend directory**:
   ```bash
   cd reply-with-ai/backend
   ```

2. **Create a virtual environment** (recommended):
   ```bash
   python -m venv venv
   # Windows
   venv\Scripts\activate
   # macOS/Linux
   source venv/bin/activate
   ```

3. **Install dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment**:
   ```bash
   cp .env.example .env
   ```

   Edit `.env` and add your Ollama Cloud API key:
   ```
   OLLAMA_API_KEY=your_api_key_here
   OLLAMA_MODEL=qwen3.5
   ```

5. **Start the backend server**:
   ```bash
   uvicorn main:app --reload --host 0.0.0.0 --port 8000
   ```

   The server will start at `http://localhost:8000`

6. **Verify the backend is running**:
   Open http://localhost:8000/health in your browser - you should see `{"status": "ok"}`

## Extension Setup

1. **Get Gmail OAuth Client ID**:

   a. Go to [Google Cloud Console](https://console.cloud.google.com/)

   b. Create a new project or select an existing one

   c. Enable the Gmail API:
      - Go to "APIs & Services" > "Library"
      - Search for "Gmail API" and enable it

   d. Create OAuth credentials:
      - Go to "APIs & Services" > "Credentials"
      - Click "Create Credentials" > "OAuth client ID"
      - Application type: **Chrome extension**
      - Copy the Client ID

   e. Update `extension/manifest.json`:
      - Replace `YOUR_GMAIL_OAUTH_CLIENT_ID` with your actual Client ID
      - The scopes are already configured for Gmail read and compose access

2. **Load the extension in Chrome**:

   a. Open Chrome and navigate to `chrome://extensions/`

   b. Enable **Developer mode** (toggle in top-right corner)

   c. Click **Load unpacked**

   d. Select the `reply-with-ai/extension` folder

   e. The extension icon should appear in your toolbar

3. **Configure CORS** (if needed):

   After loading the extension, Chrome assigns it a unique ID. To allow CORS:

   a. Find your extension ID at `chrome://extensions/` (looks like `abcdefghijklmnopqrstuvwxyz123456`)

   b. Update the CORS settings in `backend/main.py` or add your extension ID to allowed origins

## How It Works

### Architecture Overview

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Gmail UI      │────▶│  Chrome Ext     │────▶│  FastAPI        │
│   (content_     │     │  (background.js)│     │  Backend        │
│   script.js)    │     │                 │     │                 │
└─────────────────┘     └─────────────────┘     └────────┬────────┘
                                                         │
                                                  ┌──────▼───────┐
                                                  │   Ollama     │
                                                  │   (Qwen3)    │
                                                  └──────────────┘
                                                         │
                                                  ┌──────▼───────┐
                                                  │   ChromaDB   │
                                                  │   (RAG)      │
                                                  └──────────────┘
```

### Workflow

1. **User clicks "Reply"** in Gmail
2. **Content script detects** the reply compose box and injects "Reply with AI" button
3. **User clicks "Reply with AI"**:
   - Extracts sender email from thread header
   - Extracts email body text
   - Sends message to background script

4. **Background script**:
   - Gets OAuth token via `chrome.identity.getAuthToken()`
   - POSTs to backend `/reply` endpoint with token and email data

5. **Backend**:
   - Checks if sender emails are indexed in ChromaDB
   - If not, fetches past emails via Gmail API and ingests them
   - Embeds current thread text
   - Retrieves top 5 relevant chunks from ChromaDB
   - Builds prompt with context + current thread
   - Calls Qwen 3 via Ollama with streaming
   - Streams response back to extension

6. **Extension sidebar**:
   - Displays streaming draft in editable textarea
   - User can edit before inserting
   - "Insert into reply" button puts draft into Gmail compose box

### RAG Implementation

- **Chunking**: Emails are split into ~300 token chunks with 50 token overlap
- **Embeddings**: nomic-embed-text model via Ollama (768 dimensions) or cloud equivalent
- **Storage**: ChromaDB with persistent storage in `./chroma_db/`
- **Collections**: Named by MD5 hash of sender email for privacy
- **Retrieval**: Top-k most relevant chunks based on cosine similarity

## Usage

1. **Open Gmail** in Chrome

2. **Open an email** and click "Reply"

3. **Click "Reply with AI"** button (appears next to Gmail's formatting buttons)

4. **Wait for the sidebar** to open and generate a draft

5. **Review and edit** the draft if needed

6. **Click "Insert into reply"** to add the draft to your email

7. **Send** your email as usual

## Troubleshooting

### Backend won't start
- Ensure Ollama is running: `ollama serve`
- Check if port 8000 is available
- Verify Python dependencies: `pip install -r requirements.txt`

### Extension not working
- Check that OAuth Client ID is correctly set in manifest.json
- Ensure extension has necessary permissions
- Try reloading the extension at `chrome://extensions/`

### "Token expired" error
- Re-authenticate by clicking the extension icon
- Clear cached tokens at `chrome://extensions/` > Reload

### API authentication errors
- Verify your `OLLAMA_API_KEY` is correct in `.env`
- Check that Qwen 3.5 is available in your Ollama Cloud account

### No emails fetched
- Ensure Gmail API scopes are granted
- Check that the sender has sent you emails before
- Verify OAuth token is valid

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/ingest` | POST | Ingest emails from a sender |
| `/reply` | POST | Generate a reply draft (streaming) |
| `/stats/{sender_email}` | GET | Get RAG collection stats |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Ollama API endpoint |
| `OLLAMA_MODEL` | `qwen3.5` | LLM model to use |
| `OLLAMA_API_KEY` | `""` | Ollama Cloud API key |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding model |
| `CHROMA_PERSIST_DIR` | `./chroma_db` | ChromaDB storage path |
| `HOST` | `0.0.0.0` | Backend host |
| `PORT` | `8000` | Backend port |

## Security Notes

- OAuth tokens are passed from extension to backend but never stored
- Email data is sent to Ollama Cloud for inference - ensure you're comfortable with this
- ChromaDB collections use hashed sender emails for privacy
- CORS is permissive for local development - restrict in production
