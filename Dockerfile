# Cryobiology V — Docker-образи (Python і всі залежності всередині, ставити на ПК нічого, крім Docker).
#
# Два образи з одного файлу (див. DOCKER.md):
#   mask-picker   — редактор (Flask) + bake/export. CPU-only torch (потрібен cellsegkit-у для bake).
#   segmentation  — mask-picker + ML-моделі (cellpose / instanseg / ultralytics) для run_segmentation.py.
#
# Збирати й запускати через docker compose (docker-compose.yml), не напряму.

# ─────────────────────────────────────────────────────────────────────────────
FROM python:3.12-slim AS mask-picker

# libgl1 / libglib2.0-0 / libxcb1 — системні бібліотеки, без яких не імпортується opencv (cv2).
RUN apt-get update \
 && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 \
 && rm -rf /var/lib/apt/lists/*

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MPLBACKEND=Agg \
    # cellsegkit — локальний пакет, підключаємо через PYTHONPATH (як run.bat), без pip install -e:
    # pip install -e тягнув би cellpose + повний CUDA-torch (~5 ГБ), а редактору вони не потрібні.
    PYTHONPATH=/app/shared/cellsegkit

WORKDIR /app

# CPU-збірка torch (~200 МБ замість ~2.5 ГБ CUDA): cellsegkit імпортує torch на верхньому рівні,
# без нього Mask Picker стартує, але bake/export повертають 503.
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch torchvision

COPY apps/mask_picker/requirements.txt apps/mask_picker/requirements.txt
# tqdm / psutil — імпорти cellsegkit, яких нема в requirements.txt Mask Picker-а.
RUN pip install -r apps/mask_picker/requirements.txt tqdm psutil

COPY . .

EXPOSE 5000
# 0.0.0.0 — щоб сервер був доступний з-поза контейнера; браузер відкриваєш сам на хості.
ENTRYPOINT ["python", "apps/mask_picker/app.py", "--host", "0.0.0.0", "--port", "5000", "--no-browser"]
CMD ["--workspace", "/app/data/vesicles_good"]

# ─────────────────────────────────────────────────────────────────────────────
FROM mask-picker AS segmentation

# Версії зафіксовані, щоб образ збирався однаково і через рік. cellpose / ultralytics — як у
# cryobiology4/config/requirements-v3.1.txt; instanseg-torch 0.0.9 звідти не ставиться на Python ≥3.12.
RUN pip install --extra-index-url https://download.pytorch.org/whl/cpu \
      cellpose==4.0.3 instanseg-torch==0.1.2 ultralytics==8.3.27

# Кеші завантажених моделей (Cellpose-SAM ~1.2 ГБ тощо) — у volume /cache, щоб не качати щоразу.
ENV CELLPOSE_LOCAL_MODELS_PATH=/cache/cellpose \
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch \
    YOLO_CONFIG_DIR=/cache/ultralytics

ENTRYPOINT ["python", "apps/segmentation/run_segmentation.py"]
CMD ["--help"]
