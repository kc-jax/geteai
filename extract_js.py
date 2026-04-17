
import os

html_path = r'c:\Users\Jackson\2026\geteai\index.html'
js_path = r'c:\Users\Jackson\2026\geteai\temp_check.js'

try:
    with open(html_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.splitlines()
    start_idx = -1
    end_idx = -1

    for i, line in enumerate(lines):
        if '<script type="module">' in line:
            start_idx = i
        if '</script>' in line and i > start_idx:
            end_idx = i
            break # Fixed comment

    if start_idx != -1 and end_idx != -1:
        js_lines = lines[start_idx+1 : end_idx]
        js_content = '\n'.join(js_lines)
        
        with open(js_path, 'w', encoding='utf-8') as f:
            f.write(js_content)
        print("Extracted JS lines")
    else:
        print("FAILED to find script tags")

except Exception as e:
    print(f"ERROR: {e}")
