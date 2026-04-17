
path = r'c:\Users\Jackson\2026\geteai\index.html'
try:
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    # 0-indexed.
    # We want to remove lines 1514 to 1533 (inclusive of function body)
    # View showed:
    # 1514: // Helper...
    # 1532: }
    # 1533: (blank)
    
    new_lines = lines[:1513] + lines[1533:]
    
    with open(path, 'w', encoding='utf-8') as f:
        f.writelines(new_lines)
    print("Deleted lines 1514-1533")
    
except Exception as e:
    print(f"Error: {e}")
