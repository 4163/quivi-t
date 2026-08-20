import sqlite3
import sys
import os
import json
from datetime import datetime

# Adjust to the user's actual path from the prompt context
DB_PATH = os.path.expanduser(r'C:\Users\x4163\.local\share\opencode\opencode.db')
PROJECT_FILTER = '%QuiviT%'

def get_db():
    if not os.path.isfile(DB_PATH):
        print(f"Error: OpenCode DB not found at {DB_PATH}")
        sys.exit(1)
    return sqlite3.connect(DB_PATH)

def format_ts(ts):
    if not ts: return "N/A"
    # Some DBs use milliseconds, some seconds. OpenCode typically uses ms for these.
    try:
        return datetime.fromtimestamp(ts / 1000).strftime('%Y-%m-%d %H:%M')
    except:
        return datetime.fromtimestamp(ts).strftime('%Y-%m-%d %H:%M')

def cmd_list():
    db = get_db()
    rows = db.execute("""
        SELECT id, slug, title, time_updated, model, tokens_input, tokens_output, tokens_reasoning
        FROM session 
        WHERE directory LIKE ? 
        ORDER BY time_updated DESC
    """, (PROJECT_FILTER,)).fetchall()
    
    print(f"=== OpenCode Sessions (Project: QuiviT) ===")
    if not rows:
        print("No sessions found.")
        return

    for r in rows:
        s_id, slug, title, updated, model, t_in, t_out, t_reason = r
        date_str = format_ts(updated)
        tokens = (t_in or 0) + (t_out or 0) + (t_reason or 0)
        print(f"ID: {s_id}")
        print(f"Title: {title or slug}")
        print(f"Date: {date_str} | Model: {model or 'N/A'} | Tokens: {tokens}")
        print("-" * 40)
    db.close()

def cmd_read(session_id):
    db = get_db()
    
    # Get session info
    sess = db.execute("SELECT title, slug FROM session WHERE id = ?", (session_id,)).fetchone()
    if not sess:
        print(f"Error: Session {session_id} not found.")
        db.close()
        sys.exit(1)
        
    print(f"=== Session: {sess[0] or sess[1]} ({session_id}) ===")
    
    # OpenCode typically stores message metadata in `message` and text content in `part`
    # The JSON structure in part.data contains the actual text.
    msgs = db.execute("""
        SELECT m.time_created, m.data, p.data
        FROM message m
        LEFT JOIN part p ON p.message_id = m.id
        WHERE m.session_id = ? 
        ORDER BY m.time_created ASC
    """, (session_id,)).fetchall()
    
    for m in msgs:
        time_created, m_data, p_data = m
        m_json = json.loads(m_data) if m_data else {}
        p_json = json.loads(p_data) if p_data else {}
        
        role = m_json.get('role', 'unknown').upper()
        text = p_json.get('text', '')
        if not text and p_json.get('tool_calls'):
            text = f"[Tool calls: {len(p_json.get('tool_calls'))}]"
            
        print(f"\n[{role}] {format_ts(time_created)}")
        print(text)
        
    db.close()

def cmd_search(keyword):
    db = get_db()
    query = f"%{keyword}%"
    
    # Search in titles
    title_rows = db.execute("""
        SELECT id, slug, title, time_updated
        FROM session 
        WHERE directory LIKE ? AND (title LIKE ? OR slug LIKE ?)
        ORDER BY time_updated DESC
    """, (PROJECT_FILTER, query, query)).fetchall()
    
    print(f"=== Sessions matching '{keyword}' in title ===")
    for r in title_rows:
        print(f"ID: {r[0]} | Date: {format_ts(r[3])} | Title: {r[2] or r[1]}")
        
    # Search in message contents
    msg_rows = db.execute("""
        SELECT DISTINCT s.id, s.title, s.slug, m.time_created
        FROM session s
        JOIN message m ON m.session_id = s.id
        JOIN part p ON p.message_id = m.id
        WHERE s.directory LIKE ? AND p.data LIKE ?
        ORDER BY m.time_created DESC
    """, (PROJECT_FILTER, query)).fetchall()
    
    print(f"\n=== Sessions matching '{keyword}' in message content ===")
    for r in msg_rows:
        print(f"ID: {r[0]} | Date: {format_ts(r[3])} | Title: {r[1] or r[2]}")
        
    db.close()

def main():
    if len(sys.argv) < 2:
        print("Usage: python opencode.py <list|read <id>|search <keyword>>")
        sys.exit(1)
        
    cmd = sys.argv[1].lower()
    if cmd == 'list':
        cmd_list()
    elif cmd == 'read':
        if len(sys.argv) < 3:
            print("Error: session id required")
            sys.exit(1)
        cmd_read(sys.argv[2])
    elif cmd == 'search':
        if len(sys.argv) < 3:
            print("Error: search keyword required")
            sys.exit(1)
        cmd_search(sys.argv[2])
    else:
        print(f"Unknown command: {cmd}")

if __name__ == '__main__':
    main()
