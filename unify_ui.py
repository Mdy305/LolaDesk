import os
import glob
import re

TARGET_DIR = '/Users/jeromet/Desktop/LolaDesk-prod'
html_files = glob.glob(os.path.join(TARGET_DIR, '*.html'))

OLD_VIEWPORT = r'<meta name="viewport" content="width=device-width,initial-scale=1"/>'
NEW_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">'

def process_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()

    original_content = content

    # 1. Update Viewport
    if OLD_VIEWPORT in content:
        content = content.replace(OLD_VIEWPORT, NEW_VIEWPORT)
    elif '<meta name="viewport"' not in content:
        # Inject just before </head> if missing entirely
        content = content.replace('</head>', f'  {NEW_VIEWPORT}\n</head>')

    # 2. Convert strict widths to max-widths for responsiveness
    # Look for common layout containers in inline styles
    content = re.sub(r'width:\s*(\d+)px;', r'width: 100%; max-width: \1px;', content)
    
    # 3. Standardize inline font-family
    content = re.sub(r'font-family:\s*[^;]+;', r"font-family: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', sans-serif;", content)

    if content != original_content:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated {os.path.basename(filepath)}")

for filepath in html_files:
    process_file(filepath)

print("UI Unification Complete.")
