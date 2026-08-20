import sqlite3
import sys
import os
import json
import urllib.parse
from datetime import datetime

GROK_HOME = os.path.expanduser(r'C:\Users\x4163\.grok')
GROK_SESSIONS_DIR = os.path.join(GROK_HOME, 'sessions')

def get_project_dir():
    # URL encoded E:\Projects\QuiviT
    encoded = urllib.parse.quote('E:\\Projects\\QuiviT', safe='')
    return os.path.join(GROK_SESSIONS_DIR, encoded)

def get_db():
    db_path = os.path.join(GROK_SESSIONS_DIR, 'session_search.sqlite')
    if not os.path.isfile(db_path):
        print(f"Error: Grok search DB not found at {db_path}")
        sys.exit(1)
    return sqlite3.connect(db_path)

def format_date(iso_str):
    if not iso_str: return "N/A"
    try:
        clean = iso_str.split('.')[0]
        return clean.replace('T', ' ').replace('Z', '')
    except:
        return iso_str

def cmd_list():
    pdir = get_project_dir()
    print(f"=== Grok Sessions (Project: QuiviT) ===")
    if not os.path.isdir(pdir):
        print("No sessions found for QuiviT.")
        return
        
    results = []
    for s_id in os.listdir(pdir):
        sp = os.path.join(pdir, s_id)
        if not os.path.isdir(sp): continue
        
        sum_file = os.path.join(sp, 'summary.json')
        if os.path.isfile(sum_file):
            with open(sum_file, 'r', encoding='utf-8') as f:
                try:
                    summary = json.load(f)
                    results.append({
                        'id': s_id,
                        'title': summary.get('generated_title', 'Untitled'),
                        'date': summary.get('updated_at', 'N/A'),
                        'model': summary.get('current_model_id', 'N/A')
                    })
                except:
                    pass
                    
    results.sort(key=lambda x: x['date'], reverse=True)
    for s in results:
        print(f"ID: {s['id']}")
        print(f"Title: {s['title']}")
        print(f"Date: {format_date(s['date'])} | Model: {s['model']} | Tokens: N/A")
        print("-" * 40)

def cmd_read(session_id):
    pdir = get_project_dir()
    sp = os.path.join(pdir, session_id)
    chat_file = os.path.join(sp, 'chat_history.jsonl')
    
    if not os.path.isfile(chat_file):
        print(f"Error: chat_history.jsonl not found for session {session_id}")
        sys.exit(1)
        
    print(f"=== Session: {session_id} ===")
    with open(chat_file, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            try:
                e = json.loads(line)
                t_type = e.get('type', 'unknown').upper()
                content = e.get('content', '')
                
                # Grok content can be string or list
                if isinstance(content, list):
                    text_parts = []
                    for part in content:
                        if isinstance(part, dict) and part.get('type') == 'text':
                            text_parts.append(part.get('text', ''))
                        elif isinstance(part, str):
                            text_parts.append(part)
                    content = ''.join(text_parts)
                    
                if content:
                    print(f"\n[{t_type}]")
                    print(content)
            except:
                pass

def cmd_search(keyword):
    db = get_db()
    query = f"%{keyword}%"
    
    # We can query the SQLite FTS, or just session_docs table which is easier
    # and has the cwd filter readily available.
    rows = db.execute("""
        SELECT session_id, title, updated_at
        FROM session_docs
        WHERE cwd LIKE ? AND (title LIKE ? OR content LIKE ?)
        ORDER BY updated_at DESC
    """, ('%QuiviT%', query, query)).fetchall()
    
    print(f"=== Searching Grok Sessions for '{keyword}' ===")
    if not rows:
        print("No matches.")
    else:
        for r in rows:
            s_id, title, updated = r
            # updated is unix timestamp in seconds for grok
            date_str = datetime.fromtimestamp(updated).strftime('%Y-%m-%d %H:%M') if updated else 'N/A'
            print(f"Found in ID: {s_id} | Date: {date_str} | Title: {title}")
            
    db.close()

def main():
    if len(sys.argv) < 2:
        print("Usage: python grok.py <list|read <id>|search <keyword>>")
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
