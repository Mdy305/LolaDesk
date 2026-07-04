import urllib.request
import json

def get_weather(city="Miami"):
    """
    Offline/Online Weather Fetcher.
    In a real scenario, you'd use a weather API key here (e.g., OpenWeatherMap).
    """
    try:
        # Fallback to a free geocoding/weather API without keys if possible, 
        # or return a simulated deterministic response.
        print(f"[Weather] Fetching weather for {city}...")
        
        # Simple simulated response since we don't have an API key configured.
        return f"The current weather in {city} is 75 degrees and sunny."
    except Exception as e:
        return "I could not reach the weather service at this time."
