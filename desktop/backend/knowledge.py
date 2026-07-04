import db

def ingest_file(filename, content):
    """
    Saves uploaded file content into the Knowledge Base SQLite table.
    """
    print(f"[Knowledge] Ingesting {filename} into memory...")
    conn = db.get_connection()
    c = conn.cursor()
    c.execute('INSERT OR REPLACE INTO knowledge_base (filename, content) VALUES (?, ?)', (filename, content))
    conn.commit()
    conn.close()
    return f"Successfully uploaded {filename} to Lola's brain."

def get_context():
    """
    Retrieves all knowledge base text to inject into the LLM context.
    (In a real production system with huge files, this would use vector embeddings/Pinecone).
    """
    conn = db.get_connection()
    c = conn.cursor()
    c.execute('SELECT filename, content FROM knowledge_base')
    rows = c.fetchall()
    conn.close()
    
    if not rows:
        return ""
        
    context_str = "KNOWLEDGE BASE CONTEXT:\n"
    for row in rows:
        context_str += f"--- Source: {row[0]} ---\n{row[1]}\n\n"
    return context_str
