import sqlite3
import sys
import os
import json
from datetime import datetime
import glob

# Antigravity stores both CLI and IDE versions
AGY_CLI_DIR = os.path.expanduser(r'C:\Users\x4163\.gemini\antigravity-cli')
AGY_IDE_DIR = os.path.expanduser(r'C:\Users\x4163\.gemini\antigravity-ide')
PROJECT_FILTER = '%QuiviT%'

def get_cli_summaries():
    db_path = os.path.join(AGY_CLI_DIR, 'conversation_summaries.db')
    if not os.path.isfile(db_path):
        return []
    
    db = sqlite3.connect(db_path)
    # The workspace_uris column usually contains the project path
    rows = db.execute("""
        SELECT conversation_id, title, last_modified_time, agent_name, workspace_uris, step_count
        FROM conversation_summaries
        WHERE workspace_uris LIKE ?
        ORDER BY last_modified_time DESC
    """, (PROJECT_FILTER,)).fetchall()
    db.close()
    
    results = []
    for r in rows:
        c_id, title, last_mod, agent, uris, steps = r
        results.append({
            'id': c_id,
            'title': title,
            'date': last_mod.split('.')[0] if last_mod else 'N/A', # e.g. 2026-08-20 12:34:56.123
            'agent': agent,
            'steps': steps,
            'source': 'CLI'
        })
    return results

def get_ide_summaries():
    # IDE doesn't have a single summaries DB, we have to look at the brain dir or parse all DBs.
    # Actually, Antigravity IDE might not have `conversation_summaries.db`.
    # Let's just list what we can find in the IDE brain dir for this project.
    # Since we can't easily filter by project without reading all DBs, we'll scan the DBs.
    results = []
    conv_dir = os.path.join(AGY_IDE_DIR, 'conversations')
    if not os.path.isdir(conv_dir):
        return results
        
    for db_name in os.listdir(conv_dir):
        if not db_name.endswith('.db'):
            continue
        c_id = db_name[:-3]
        db_path = os.path.join(conv_dir, db_name)
        
        # We can try to extract title from steps if needed, but it's slow.
        # Often, the user provides the ID, so listing might just show IDs and modified times for IDE.
        mtime = datetime.fromtimestamp(os.path.getmtime(db_path)).strftime('%Y-%m-%d %H:%M:%S')
        results.append({
            'id': c_id,
            'title': 'Unknown (IDE Session)',
            'date': mtime,
            'agent': 'Antigravity IDE',
            'steps': 'N/A',
            'source': 'IDE'
        })
    
    # Sort by date descending
    results.sort(key=lambda x: x['date'], reverse=True)
    return results

def cmd_list():
    cli_sessions = get_cli_summaries()
    ide_sessions = get_ide_summaries()
    
    print(f"=== Antigravity Sessions (CLI Project: QuiviT) ===")
    for s in cli_sessions:
        print(f"ID: {s['id']} [CLI]")
        print(f"Title: {s['title']}")
        print(f"Date: {s['date']} | Agent: {s['agent']} | Steps: {s['steps']}")
        print("-" * 40)
        
    print(f"\n=== Antigravity Sessions (IDE - All Projects) ===")
    # Print top 10 IDE sessions to avoid spam
    for s in ide_sessions[:10]:
        print(f"ID: {s['id']} [IDE]")
        print(f"Date: {s['date']} | Agent: {s['agent']}")
        print("-" * 40)
    if len(ide_sessions) > 10:
        print(f"... and {len(ide_sessions) - 10} more IDE sessions.")

def get_transcript_path(session_id):
    # Check CLI
    p = os.path.join(AGY_CLI_DIR, 'brain', session_id, '.system_generated', 'logs', 'transcript.jsonl')
    if os.path.isfile(p): return p
    # Check IDE
    p = os.path.join(AGY_IDE_DIR, 'brain', session_id, '.system_generated', 'logs', 'transcript.jsonl')
    if os.path.isfile(p): return p
    return None

def cmd_read(session_id):
    t_path = get_transcript_path(session_id)
    if not t_path:
        print(f"Error: Transcript for session {session_id} not found.")
        sys.exit(1)
        
    print(f"=== Session: {session_id} ===")
    with open(t_path, 'r', encoding='utf-8') as f:
        for line in f:
            if not line.strip(): continue
            e = json.loads(line)
            source = e.get('source', 'UNKNOWN')
            t_type = e.get('type', 'UNKNOWN')
            content = e.get('content', '')
            
            if source == 'MODEL' and t_type == 'PLANNER_RESPONSE':
                print(f"\n[MODEL]")
                print(content)
                # Print tool calls
                for tc in e.get('tool_calls', []):
                    tc_name = tc.get('function', {}).get('name', 'unknown_tool')
                    print(f"  > Tool: {tc_name}")
            elif source == 'USER_EXPLICIT' and t_type == 'USER_INPUT':
                print(f"\n[USER]")
                print(content)

def cmd_search(keyword):
    print(f"=== Searching Antigravity CLI Transcripts for '{keyword}' ===")
    cli_brain = os.path.join(AGY_CLI_DIR, 'brain')
    _search_brain_dir(cli_brain, keyword)
    
    print(f"\n=== Searching Antigravity IDE Transcripts for '{keyword}' ===")
    ide_brain = os.path.join(AGY_IDE_DIR, 'brain')
    _search_brain_dir(ide_brain, keyword)

def _search_brain_dir(brain_dir, keyword):
    if not os.path.isdir(brain_dir):
        return
        
    found = 0
    keyword_lower = keyword.lower()
    for c_id in os.listdir(brain_dir):
        t_path = os.path.join(brain_dir, c_id, '.system_generated', 'logs', 'transcript.jsonl')
        if not os.path.isfile(t_path):
            continue
            
        with open(t_path, 'r', encoding='utf-8') as f:
            for line in f:
                if keyword_lower in line.lower():
                    print(f"Found in session ID: {c_id}")
                    found += 1
                    break
    if found == 0:
        print("No matches.")

def main():
    if len(sys.argv) < 2:
        print("Usage: python antigravity.py <list|read <id>|search <keyword>>")
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
