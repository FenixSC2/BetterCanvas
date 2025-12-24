import os

CANVAS_BASE_URL = "https://northeastern.instructure.com"

# Temporary: environment variable
CANVAS_API_TOKEN = os.getenv("CANVAS_API_TOKEN")

if not CANVAS_API_TOKEN:
    raise RuntimeError(
        "Set CANVAS_API_TOKEN environment variable"
    )

HEADERS = {
    "Authorization": f"Bearer {CANVAS_API_TOKEN}"
}
