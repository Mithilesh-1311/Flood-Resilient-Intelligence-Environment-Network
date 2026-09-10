# FRiEND controller - Hugging Face Spaces (Docker SDK).
# Also runs unchanged on Render, Railway, Fly.io or Cloud Run: serve.py honours $PORT.

FROM python:3.11-slim

# PORT must equal app_port in README.md (8000). Pinned here so the listener
# matches even if a platform injects a different default; hosts that route by
# $PORT (Render, Railway, Cloud Run) override it at runtime, which serve.py honours.
ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    TF_CPP_MIN_LOG_LEVEL=2 \
    PORT=8000

# Hugging Face Spaces run the container as uid 1000; Keras also wants a
# writable home for ~/.keras.
RUN useradd --create-home --uid 1000 user

WORKDIR /app

# Dependencies first, so code-only changes rebuild in seconds.
COPY --chown=user requirements.txt .
RUN pip install -r requirements.txt

# Same layout as the project: flood_ai.py resolves ../models and ../flood_dataset.
COPY --chown=user HARDWARE ./HARDWARE
COPY --chown=user models ./models
COPY --chown=user flood_dataset ./flood_dataset

USER user
WORKDIR /app/HARDWARE

EXPOSE 8000
CMD ["python", "serve.py"]
