import feature
import weather_fetcher
import db
import diagnostic

def parse_and_execute(command):
    """
    NLP Command Parser (Stub).
    In a real app, this routes to an AI Chatbot (LLM) or deterministic intents.
    """
    cmd = command.lower()
    
    if "play" in cmd and "youtube" in cmd:
        query = cmd.replace("play", "").replace("youtube", "").strip()
        if not query:
            query = "Lofi hip hop radio"
        return feature.play_youtube(query)
        
    elif "whatsapp" in cmd:
        # Simplistic parsing
        # "Send whatsapp to +12345 saying hello"
        return feature.send_whatsapp("+1234567890", "Hello from Lola!")
        
    elif "search" in cmd:
        query = cmd.replace("search", "").strip()
        return feature.search_web(query)
        
    elif "weather" in cmd:
        return weather_fetcher.get_weather()
        
    elif any(word in cmd for word in ["recommend", "quote", "diagnostic", "look", "what do you think", "how does"]):
        return diagnostic.run_diagnostic(command)
        
    else:
        # Fallback to AI Chatbot
        print(f"[AI] Routing '{command}' to AI Chatbot...")
        # Save to DB memory as latest unknown command
        db.set_memory("last_unknown_cmd", command)
        return "I am processing that request using the AI Chatbot."
