import speech_recognition as sr
import pyttsx3
import threading
import time

def speak(text):
    """Fallback offline TTS"""
    try:
        engine = pyttsx3.init()
        engine.say(text)
        engine.runAndWait()
    except Exception as e:
        print(f"[TTS Error] {e}")

def listen():
    """Listen for a command using the microphone."""
    recognizer = sr.Recognizer()
    with sr.Microphone() as source:
        print("[Voice] Adjusting for ambient noise...")
        recognizer.adjust_for_ambient_noise(source)
        print("[Voice] Listening...")
        try:
            audio = recognizer.listen(source, timeout=5, phrase_time_limit=10)
            print("[Voice] Recognizing...")
            text = recognizer.recognize_google(audio)
            print(f"[Voice] Heard: {text}")
            return text
        except sr.UnknownValueError:
            return "Could not understand audio"
        except sr.RequestError as e:
            return f"Error connecting to recognition service: {e}"
        except Exception as e:
            return f"Error: {e}"

def start_hotword_thread(on_hotword_callback):
    """Background thread for 'Hey Lola' detection (Placeholder)"""
    def hotword_loop():
        # In a real app, use Porcupine or snowboy here.
        # For now, this is just a stub loop.
        while True:
            time.sleep(1)
            # if hotword_detected():
            #     on_hotword_callback()
    
    t = threading.Thread(target=hotword_loop, daemon=True)
    t.start()
