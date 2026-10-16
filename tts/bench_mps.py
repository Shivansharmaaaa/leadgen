import time, torch, warnings
warnings.filterwarnings("ignore")
from kokoro import KPipeline
import soundfile as sf

print(f"  mps available: {torch.backends.mps.is_available()}")
for device in (["mps", "cpu"] if torch.backends.mps.is_available() else ["cpu"]):
    try:
        pipe = KPipeline(lang_code="a", device=device)
    except Exception as e:
        print(f"  {device}: pipeline failed — {e}"); continue
    # Short sentence, the realistic unit for streaming TTS.
    text = "Sorry to hear that. How long has it been blowing warm air?"
    list(pipe(text, voice="af_heart"))          # warm
    t = time.time(); chunks = list(pipe(text, voice="af_heart")); gen = time.time() - t
    audio = chunks[0][2]; dur = len(audio) / 24000
    print(f"  {device:<4} {gen:.2f}s for {dur:.1f}s audio   RTF {gen/dur:.2f}")
    sf.write(f"tts/short_{device}.wav", audio, 24000)
