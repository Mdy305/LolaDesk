import cv2
import base64
import requests
import os

# Placeholder for OpenAI API Key.
# In production, load this from environment variables (e.g. os.getenv("OPENAI_API_KEY"))
OPENAI_API_KEY = "YOUR_OPENAI_API_KEY_HERE"

def capture_frame():
    """Silently captures a single high-resolution frame from the webcam."""
    print("[Vision AI] Activating camera for diagnostic scan...")
    cam = cv2.VideoCapture(0)
    ret, frame = cam.read()
    cam.release()
    
    if not ret:
        print("[Vision AI] Failed to capture image.")
        return None
        
    return frame

def encode_image(frame):
    """Encodes a cv2 frame to a base64 string for the Vision API."""
    _, buffer = cv2.imencode('.jpg', frame)
    return base64.b64encode(buffer).decode('utf-8')

def run_diagnostic(client_request):
    """
    Captures an image and sends it to a Vision-Language Model to answer the client's request.
    """
    frame = capture_frame()
    if frame is None:
        return "I'm sorry, I couldn't access the camera to run the diagnostic."

    base64_image = encode_image(frame)
    
    print(f"[Vision AI] Analyzing image for request: '{client_request}'")
    
    # Check if API key is configured
    if OPENAI_API_KEY == "YOUR_OPENAI_API_KEY_HERE":
        print("[Vision AI] NOTE: OPENAI_API_KEY is not set. Returning a simulated diagnostic.")
        return "Based on my visual scan, your hair shows slight dryness at the ends. I recommend our deep hydration restorative mask for $45. Shall I book that for you?"
    
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}"
    }
    
    payload = {
        "model": "gpt-4o",
        "messages": [
            {
                "role": "system",
                "content": "You are Lola, a premium AI salon assistant. Analyze the image to answer the client's question about their hair, skin, or style. Give a concise, professional recommendation and a hypothetical price quote based on standard premium salon pricing."
            },
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": client_request
                    },
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{base64_image}"
                        }
                    }
                ]
            }
        ],
        "max_tokens": 150
    }
    
    try:
        response = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
        return result['choices'][0]['message']['content']
    except Exception as e:
        print(f"[Vision AI] API Error: {e}")
        return "I experienced an error analyzing the image. Let's try again in a moment."
