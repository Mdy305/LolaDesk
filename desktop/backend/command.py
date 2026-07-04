import json
import requests
import db
import feature
import weather_fetcher
import diagnostic
import os

# In production, use os.getenv("OPENAI_API_KEY")
OPENAI_API_KEY = "YOUR_OPENAI_API_KEY_HERE"

# Define the tools (functions) Lola can call
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get the current weather for a specific city.",
            "parameters": {
                "type": "object",
                "properties": {
                    "city": {
                        "type": "string",
                        "description": "The city to get the weather for, e.g., Miami, London"
                    }
                },
                "required": []
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_diagnostic",
            "description": "Turn on the webcam to look at the user and run a visual diagnostic or visual recommendation based on their request.",
            "parameters": {
                "type": "object",
                "properties": {
                    "request": {
                        "type": "string",
                        "description": "What the user specifically wants you to look at or recommend."
                    }
                },
                "required": ["request"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "play_youtube",
            "description": "Play a requested song or video on YouTube.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The song or video to search for."
                    }
                },
                "required": ["query"]
            }
        }
    }
]

def parse_and_execute(command_text):
    """
    Agentic Intent Engine:
    Uses an LLM (OpenAI) to parse the intent of the user's command and 
    automatically trigger the correct Python tool.
    """
    print(f"[Agent] Processing request: '{command_text}'")
    
    # Save the command to the local SQLite database to maintain conversational memory
    db.set_memory("last_command", command_text)
    
    # If API key is not configured, fall back to simple logic for the stub
    if OPENAI_API_KEY == "YOUR_OPENAI_API_KEY_HERE":
        print("[Agent] API Key missing. Running local fallback routing.")
        cmd = command_text.lower()
        if any(w in cmd for w in ["look", "diagnostic", "recommend", "what do you think"]):
            return diagnostic.run_diagnostic(command_text)
        elif "weather" in cmd:
            return weather_fetcher.get_weather()
        elif "play" in cmd:
            q = cmd.replace("play", "").strip()
            return feature.play_youtube(q)
        else:
            return f"I saved your command '{command_text}' to my local memory, but my API key is missing to process it properly."

    # Agentic Tool Calling via OpenAI
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}"
    }
    
    payload = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": "You are Lola, a highly advanced AI salon operating system. You have access to tools to control the computer, look through the webcam, and fetch data. Use the provided tools to answer the user's request. If no tool is needed, just answer conversationally in 1-2 sentences."},
            {"role": "user", "content": command_text}
        ],
        "tools": TOOLS,
        "tool_choice": "auto"
    }
    
    try:
        response = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
        
        message = result['choices'][0]['message']
        
        # Did the LLM decide to call a tool?
        if message.get("tool_calls"):
            tool_call = message["tool_calls"][0]
            function_name = tool_call["function"]["name"]
            arguments = json.loads(tool_call["function"]["arguments"])
            
            print(f"[Agent] LLM triggered tool: {function_name}({arguments})")
            
            # Execute the requested tool locally on the machine
            if function_name == "get_weather":
                city = arguments.get("city", "Miami")
                return weather_fetcher.get_weather(city)
                
            elif function_name == "run_diagnostic":
                req = arguments.get("request", command_text)
                return diagnostic.run_diagnostic(req)
                
            elif function_name == "play_youtube":
                return feature.play_youtube(arguments["query"])
                
        else:
            # The LLM just wants to talk
            return message.get("content", "I processed your request, but have nothing to say.")
            
    except Exception as e:
        print(f"[Agent] API Error: {e}")
        return "I experienced an error connecting to my cognitive engine."
