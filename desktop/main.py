import eel
import os
import sys

# Core modules (to be implemented)
import core_voice
import core_vision
import core_commands
import core_integrations

# Initialize Eel
web_dir = os.path.join(os.path.dirname(__file__), 'web')
eel.init(web_dir)

@eel.expose
def py_lola_speak(text):
    """Fallback text-to-speech from Python side if web API fails."""
    print(f"[LOLA] Speaking: {text}")
    core_voice.speak(text)
    return True

@eel.expose
def py_start_listening():
    """Trigger Python-side speech recognition/hotword detection."""
    print("[LOLA] Started listening...")
    transcript = core_voice.listen()
    return transcript

@eel.expose
def py_face_auth():
    """Trigger Python-side Face Authentication."""
    print("[LOLA] Running face auth...")
    success = core_vision.authenticate()
    return success

@eel.expose
def py_execute_command(command):
    """Command Parser -> Feature Handlers -> DB/WhatsApp/YouTube/AI"""
    print(f"[LOLA] Executing command: {command}")
    response = core_commands.parse_and_execute(command)
    return response

def start_app():
    print("Starting Jarvis Lola Desktop...")
    core_voice.start_hotword_thread(lambda: print("Hotword Detected!"))
    
    # Use a cinematic default size. 
    # For a true kiosk mode without window chrome on macOS/Windows, we can pass cmdline_args.
    eel.start('index.html', size=(1280, 800), mode='chrome', cmdline_args=['--app=http://localhost:8000/index.html', '--disable-features=Translate'])

if __name__ == '__main__':
    start_app()
