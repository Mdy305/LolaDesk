import pywhatkit
import webbrowser

def play_youtube(query):
    """Play a video on YouTube"""
    print(f"[YouTube] Playing: {query}")
    pywhatkit.playonyt(query)
    return f"Playing {query} on YouTube"

def send_whatsapp(phone, message):
    """Send a WhatsApp message instantly"""
    print(f"[WhatsApp] Sending to {phone}: {message}")
    # pywhatkit.sendwhatmsg_instantly(phone, message, tab_close=True)
    return f"Sent WhatsApp to {phone}"

def search_web(query):
    """Search Google"""
    print(f"[Web] Searching: {query}")
    pywhatkit.search(query)
    return f"Searching for {query}"
