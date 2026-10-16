import time, sys
try:
    from kokoro import KPipeline
    import soundfile as sf
except Exception as e:
    print(f"IMPORT FAILED: {e}"); sys.exit(1)

t0 = time.time()
pipe = KPipeline(lang_code="a")
print(f"  pipeline loaded in {time.time()-t0:.1f}s")

text = "Thanks for calling Northside Heating and Air. I'm an AI assistant. What can I help you with?"
for voice in ["af_heart", "af_bella", "am_michael"]:
    t = time.time()
    chunks = list(pipe(text, voice=voice))
    gen = time.time() - t
    audio = chunks[0][2]
    dur = len(audio) / 24000
    sf.write(f"tts/sample_{voice}.wav", audio, 24000)
    print(f"  {voice:<12} {gen:.2f}s to generate {dur:.1f}s of audio   RTF {gen/dur:.2f}")
