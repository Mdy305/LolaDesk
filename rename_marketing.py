import os
import glob

TARGET_DIR = '/Users/jeromet/Desktop/LolaDesk-prod'
html_files = glob.glob(os.path.join(TARGET_DIR, '*.html'))

old_marketing = '<div class="nav-item" onclick="location.href=\'marketing.html\'"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 11l18-5v12L3 13v-2zM11.6 16.8a3 3 0 11-5.8-1.6"/></svg>Marketing</div>'
new_email = '<div class="nav-item" onclick="location.href=\'marketing.html\'"><svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z"/></svg>Email</div>'

for filepath in html_files:
    with open(filepath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    if old_marketing in content:
        content = content.replace(old_marketing, new_email)
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Updated {os.path.basename(filepath)}")
    elif 'Marketing</div>' in content:
        # Fallback if SVG paths varied slightly
        content = content.replace('Marketing</div>', 'Email</div>')
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(content)
        print(f"Fallback updated {os.path.basename(filepath)}")
