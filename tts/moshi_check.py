"""Load Moshi and measure a generation step, to see what it is actually worth here."""
import time, warnings, os
warnings.filterwarnings("ignore")
os.environ.setdefault("SSL_CERT_FILE", "")

import mlx.core as mx
from moshi_mlx import models
from moshi_mlx.utils import load_model  # noqa: F401

W = "models/moshi/model.q4.safetensors"
T = "models/moshi/tokenizer_spm_32k_3.model"
M = "models/moshi/tokenizer-e351c8d8-checkpoint125.safetensors"

print(f"  mlx default device: {mx.default_device()}")
t0 = time.time()
try:
    cfg = models.config_v0_1()
    print(f"  config: {cfg.transformer.d_model}d, {cfg.transformer.num_layers} layers")
    model = models.Lm(cfg)
    model.set_dtype(mx.bfloat16)
    print(f"  model constructed in {time.time()-t0:.1f}s")

    t1 = time.time()
    model.load_pytorch_weights(W, cfg, strict=True)
    print(f"  weights loaded in {time.time()-t1:.1f}s")
except Exception as e:
    print(f"  load path differs in 0.3.0: {type(e).__name__}: {str(e)[:160]}")
