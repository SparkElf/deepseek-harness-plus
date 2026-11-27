# MinerU 4.x parsing API — self-contained, CPU only, no network at runtime.
#
# Why this image exists
# --------------------
# MinerU needs ~110 Python packages (~2.5 GB installed) plus ~820 MB of model weights.
# Installing that per customer host is not realistic, and the customer intranet has no
# egress, so the weights must already be inside the image. Hence one image + one
# compose file, started with `docker compose up -d`.
#
# Why CPU / ONNX and NOT paddlepaddle + paddleocr
# ----------------------------------------------
# MinerU 3.x used PaddleOCR; MinerU 4.x does not depend on paddle at all. It ships ONNX
# models and runs them through `onnxruntime` — verified on 4.0.12: `pip show mineru`
# lists onnxruntime as a dependency, and `mineru-kit models download --small-backend`
# accepts only `auto|onnx|torch`. Installing paddlepaddle here would add ~500 MB that no
# code path ever calls. CPU is enforced by (a) onnxruntime, which has no CUDA provider in
# this image, (b) blanking CUDA device visibility, and (c) the `basic` tier, whose models
# are the ONNX bundle.
#
# Build arguments
# ---------------
# PIP_INDEX_URL / PIP_TRUSTED_HOST exist because a build host can reach pypi.org and
# still time out on files.pythonhosted.org. Point them at a mirror when the default
# fails (see README). MODEL_SOURCE selects modelscope (default, China-region) or
# huggingface.

FROM python:3.11-slim

# libGL and libglib are loaded by opencv, which MinerU imports at startup; without them
# the service starts and then fails on the first parse. curl serves the healthcheck.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ARG PIP_INDEX_URL=https://pypi.org/simple
ARG PIP_TRUSTED_HOST=
ARG MODEL_SOURCE=modelscope
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_DEFAULT_TIMEOUT=120 \
    PIP_INDEX_URL=${PIP_INDEX_URL} \
    PIP_TRUSTED_HOST=${PIP_TRUSTED_HOST}

# `-U 'mineru>=4.0,<5'` lets pip resolve the dependency closure itself. Pinning every
# transitive package looks reproducible but breaks: some versions visible on an internal
# index do not exist on public PyPI, and a hand-pinned set fails to resolve.
RUN python3 -m pip install --no-cache-dir --retries 5 -U 'mineru>=4.0,<5'

# CPU-only guarantees.
ENV CUDA_VISIBLE_DEVICES="" \
    USE_GPU=false \
    MINERU_MODEL_SOURCE=local \
    MINERU_MODEL_SMALL_BACKEND=onnx \
    MINERU_MODEL_VLM_ENGINE=llama-cpp \
    MINERU_API_RETENTION_SECONDS=86400

# Bake the ONNX weights in. This is the step that makes the image work with no egress;
# it is also ~820 MB and the main reason the image is large.
RUN mineru-kit models download --tier basic --small-backend onnx --source ${MODEL_SOURCE} \
    && mineru-kit models verify --tier basic --small-backend onnx

# Non-root, and the model cache must be BOTH readable and findable by that user.
#
# MinerU resolves its cache from $HOME, so a non-root user looks under
# /home/mineru/.mineru/models, not /root/.mineru/models. Relocating the cache (rather
# than copying it twice) keeps one copy in the image and pins the lookup path for both
# the healthcheck and a manual `mineru-kit models verify`.
ENV MINERU_MODEL_BASE_DIR=/home/mineru/.mineru/models

RUN useradd --create-home --uid 10001 mineru \
    && mkdir -p /home/mineru/.mineru \
    && mv /root/.mineru/models /home/mineru/.mineru/models \
    && chown -R mineru:mineru /home/mineru/.mineru \
    && mkdir -p /data/mineru \
    && chown -R mineru:mineru /data/mineru
USER mineru

VOLUME ["/data/mineru"]
EXPOSE 8000

# A parse can run for many minutes on CPU, so health only asks whether the API answers.
# start-period covers importing onnxruntime and mmapping the layout model.
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD curl -fsS http://127.0.0.1:8000/v1/health || exit 1

ENTRYPOINT ["mineru-kit"]
CMD ["api-server", "--host", "0.0.0.0", "--port", "8000", "--tier", "basic", "--upload-dir", "/data/mineru", "--concurrency", "4"]
