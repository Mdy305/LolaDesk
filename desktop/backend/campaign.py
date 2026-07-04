import db
import knowledge
import requests
import json

# Fallback API KEY
OPENAI_API_KEY = "YOUR_OPENAI_API_KEY_HERE"

def draft_campaign(prompt):
    """
    Drafts marketing email/SMS copy based on the user's prompt, 
    using the Knowledge Base context (RAG) to ensure accuracy.
    """
    print(f"[Campaign] Drafting campaign for: '{prompt}'")
    
    # Retrieve knowledge base text (like Salon Menu pricing)
    context = knowledge.get_context()
    
    if OPENAI_API_KEY == "YOUR_OPENAI_API_KEY_HERE":
        return "Hey! We are running a special this weekend. Book now to get 20% off all styling services. (Simulated Draft)"

    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {OPENAI_API_KEY}"
    }
    
    payload = {
        "model": "gpt-4o",
        "messages": [
            {"role": "system", "content": f"You are Lola, a premium AI marketing manager for a high-end salon. Write a short, highly-converting SMS/Email draft based on the user's prompt. Use the following Knowledge Base context to ensure prices and services are accurate:\n{context}"},
            {"role": "user", "content": prompt}
        ]
    }
    
    try:
        response = requests.post("https://api.openai.com/v1/chat/completions", headers=headers, json=payload)
        response.raise_for_status()
        result = response.json()
        return result['choices'][0]['message']['content']
    except Exception as e:
        print(f"[Campaign] Error drafting: {e}")
        return "Failed to draft campaign."

def save_campaign(name, audience):
    """Saves a campaign draft to the database."""
    conn = db.get_connection()
    c = conn.cursor()
    c.execute('INSERT INTO campaigns (name, audience) VALUES (?, ?)', (name, audience))
    conn.commit()
    conn.close()
    return True
