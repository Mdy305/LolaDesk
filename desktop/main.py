import eel
import os
import sys

# Append backend directory to path so imports work cleanly
sys.path.append(os.path.join(os.path.dirname(__file__), 'backend'))

from backend import voice
from backend.auth import recognize
from backend import command
from backend import feature

# Initialize Eel
frontend_dir = os.path.join(os.path.dirname(__file__), 'frontend')
eel.init(frontend_dir)

@eel.expose
def py_lola_speak(text):
    print(f"[LOLA] Speaking: {text}")
    voice.speak(text)
    return True

@eel.expose
def py_start_listening():
    print("[LOLA] Started listening...")
    transcript = voice.listen()
    return transcript

@eel.expose
def py_face_auth():
    print("[LOLA] Running face auth...")
    # Will use the new trained LBPH model eventually
    success = recognize.authenticate()
    return success

@eel.expose
def py_execute_command(cmd):
    print(f"[LOLA] Executing command: {cmd}")
    response = command.parse_and_execute(cmd)
    return response

def start_app():
    print("Starting Jarvis Lola Desktop (Advanced Architecture)...")
    voice.start_hotword_thread(lambda: print("Hotword Detected!"))
    eel.start('index.html', size=(1280, 800), mode='chrome', cmdline_args=['--app=http://localhost:8000/index.html', '--disable-features=Translate'])

if __name__ == '__main__':
    start_app()
