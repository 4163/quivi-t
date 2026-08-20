import sys
import os
import json
import glob
from datetime import datetime

CODEX_DIR = os.path.expanduser(r'C:\Users\x4163\.codex')
INDEX_FILE = os.path.join(CODEX_DIR, 'session_index.jsonl')

def get_index():
    if not os.path.isfile(INDEX_FILE):
        return []
    
    results = []
    with open(INDEX_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            e = json.loads(line)
            # Codex doesn't easily store project filters in the index, so we list all
            # Format: {'id': '...', 'thread_name': '...', 'updated_at': '2026-05-05T00:20:03.178Z'}
            results.append({
                'id': e.get('id'),
                'title': e.get('thread_name', 'Untitled'),
                'date': e.get('updated_at', 'N/A')
            })
            
    # Sort newest first
    results.sort(key=lambda x: x['date'], reverse=True)
    return results

def format_date(iso_str):
    if iso_str == 'N/A': return iso_str
    try:
        # e.g. 2026-05-05T00:20:03.1784736Z
        clean = iso_str.split('.')[0]
        clean = clean.replace('T', ' ').replace('Z', '')
        return clean
    except:
        return iso_str

def cmd_list():
    sessions = get_index()
    print(f"=== Codex Sessions ===")
    if not sessions:
        print("No sessions found.")
        return
        
    for s in sessions[:30]: # Limit to top 30
        print(f"ID: {s['id']}")
        print(f"Title: {s['title']}")
        print(f"Date: {format_date(s['date'])} | Tokens: N/A")
        print("-" * 40)
    if len(sessions) > 30:
        print(f"... and {len(sessions) - 30} more sessions.")

def find_rollout_file(session_id):
    sessions_dir = os.path.join(CODEX_DIR, 'sessions')
    archived_dir = os.path.join(CODEX_DIR, 'archived_sessions')
    
    for d in [sessions_dir, archived_dir]:
        if not os.path.isdir(d): continue
        # rollouts look like rollout-123456789-uuid.jsonl
        pattern = os.path.join(d, '**', f'rollout-*-{session_id}.jsonl')
        matches = glob.glob(pattern, recursive=True)
        if matches:
            return matches[0]
    return None

def cmd_read(session_id):
    rollout = find_rollout_file(session_id)
    if not rollout:
        print(f"Error: Rollout for session {session_id} not found.")
        sys.exit(1)
        
    print(f"=== Session: {session_id} ===")
    
    with open(rollout, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            e = json.loads(line)
            t_type = e.get('type')
            
            if t_type == 'event_msg':
                # Not usually content, skip
                continue
            elif t_type == 'response_item':
                p = e.get('payload', {})
                role = p.get('role', 'unknown').upper()
                content = p.get('content', '')
                print(f"\n[{role}]")
                print(content)
            elif t_type == 'turn_context':
                p = e.get('payload', {})
                user_msg = p.get('message', '')
                if user_msg:
                    print(f"\n[USER]")
                    print(user_msg)

def cmd_search(keyword):
    print(f"=== Searching Codex Sessions for '{keyword}' ===")
    sessions_dir = os.path.join(CODEX_DIR, 'sessions')
    archived_dir = os.path.join(CODEX_DIR, 'archived_sessions')
    
    keyword_lower = keyword.lower()
    found = 0
    
    for d in [sessions_dir, archived_dir]:
        if not os.path.isdir(d): continue
        pattern = os.path.join(d, '**', 'rollout-*.jsonl')
        for fpath in glob.glob(pattern, recursive=True):
            with open(fpath, 'r', encoding='utf-8') as f:
                for line in f:
                    if keyword_lower in line.lower():
                        print(f"Found in: {os.path.basename(fpath)}")
                        found += 1
                        break
                        
    if found == 0:
        print("No matches.")

def main():
    if len(sys.argv) < 2:
        print("Usage: python codex.py <list|read <id>|search <keyword>>")
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
