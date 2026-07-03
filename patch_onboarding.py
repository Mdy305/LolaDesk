import re

with open('onboarding.html', 'r') as f:
    html = f.read()

# 1. Update progress bar (remove dot 5)
html = re.sub(
    r'<div class="ob-line" data-line="3"></div>\s*<div class="ob-step-dot"><div class="ob-dot" data-dot="4">5</div></div>',
    '',
    html
)

# 2. Extract Step 2 (Platform)
m2 = re.search(r'<!-- STEP 2: PLATFORM -->(.*?)<!-- STEP 3: PERSONA -->', html, re.DOTALL)
step2_html = m2.group(1)

# 3. Extract Step 4 (Plans)
m4 = re.search(r'<!-- STEP 5: PLAN \+ GO LIVE -->(.*?)<!-- GO LIVE ANIMATION -->', html, re.DOTALL)
step4_html = m4.group(1)

# 4. Extract Step 5 (Go Live)
m5 = re.search(r'<!-- GO LIVE ANIMATION -->(.*?)    </div>\s*</div>\s*</div>\s*<script>', html, re.DOTALL)
step5_html = m5.group(1)

# Modify the extracted blocks
# Update Step 4 (Plans) to be Step 2
new_step2 = step4_html.replace('data-step="4"', 'data-step="2"').replace('<!-- STEP 5: PLAN + GO LIVE -->', '<!-- STEP 2: PLAN + GO LIVE -->')

# Update Step 2 (Platform) to be Step 3, and add the Booking URL input field
new_step3 = step2_html.replace('data-step="2"', 'data-step="3"')
new_step3 = new_step3.replace('<!-- STEP 2: PLATFORM -->', '<!-- STEP 3: SYNCHRONIZATION -->')
url_input = '''
        <div class="ob-field" style="margin-top:20px">
          <label class="ob-label">Your Booking Link / Site URL</label>
          <input class="ob-input" id="f-booking-url" placeholder="https://..." />
        </div>
'''
new_step3 = new_step3.replace('<div class="ob-nav">', url_input + '<div class="ob-nav">')
new_step3 = new_step3.replace('Review & Live', 'Continue')

# Update Step 5 (Go Live) to be Step 4
new_step4 = step5_html.replace('data-step="5"', 'data-step="4"')

# Replace the giant chunk from STEP 2 to the end of STEP 5 with our new blocks
giant_chunk_regex = r'<!-- STEP 2: PLATFORM -->.*?    </div>\s*</div>\s*</div>\s*<script>'
new_giant_chunk = f"<!-- STEP 2: PLAN -->{new_step2}<!-- STEP 3: PLATFORM -->{new_step3}<!-- STEP 4: GO LIVE -->{new_step4}    </div>\n  </div>\n</div>\n\n<script>"
html = re.sub(giant_chunk_regex, new_giant_chunk, html, flags=re.DOTALL)

# Update JS State
html = re.sub(r"persona:'warm', voice:'Samantha',", "bookingUrl:'',", html)

# Remove Persona variables
html = re.sub(r"const personaGreetings = \{[\s\S]*?\};\n", "", html)
html = re.sub(r"const personaEnergy=\{[\s\S]*?\};\n", "", html)
html = re.sub(r"window\.selectPersona=\(el\)=>\{[\s\S]*?\};\n", "", html)

# Update saveStep
save_step_replacement = """function saveStep(){
  if(state.step===1){
    state.name=document.getElementById('f-name').value||'Your Salon';
    state.owner=document.getElementById('f-owner').value||'there';
    state.phone=document.getElementById('f-phone').value;
    state.type=document.getElementById('f-type').value;
    state.location=document.getElementById('f-location').value;
    state.email=document.getElementById('f-email').value.trim();
    state.password=document.getElementById('f-password').value;
  }
  if(state.step===3){
    state.bookingUrl=document.getElementById('f-booking-url').value;
  }
}"""
html = re.sub(r"function saveStep\(\)\{[\s\S]*?\}", save_step_replacement, html)

# Update showStep (loop limit 4)
html = html.replace("for(let i=0;i<5;i++){", "for(let i=0;i<4;i++){")

# Update next (limit 4)
html = html.replace("if(state.step<5){state.step++;showStep(state.step);}", "if(state.step<4){state.step++;showStep(state.step);}")
html = html.replace("if(state.step===5)renderPreview();", "if(state.step===2)renderPreview();")

# Fix renderPreview
render_preview_replacement = """function renderPreview(){
  document.getElementById('previewName').textContent = 'LOLA';
  document.getElementById('previewGreeting').textContent = "Hi! I'm Lola" + (state.name&&state.name!=='Your Salon'?` from ${state.name}`:'') + ". How can I help you today?";
}"""
html = re.sub(r"function renderPreview\(\)\{[\s\S]*?\}", render_preview_replacement, html)

# Fix goLive
golive_replacement = """window.goLive=()=>{
  saveStep();
  state.step=4;
  showStep(3); // keep last dot active
  document.querySelector('.ob-step[data-step="3"]').classList.remove('active');
  document.querySelector('.ob-step[data-step="4"]').classList.add('active');"""
html = re.sub(r"window\.goLive=\(\)=>\{\s*saveStep\(\);\s*state\.step=5;\s*showStep\(4\);[^\n]*\n\s*document\.querySelector\('\.ob-step\[data-step=\"4\"\]'\)\.classList\.remove\('active'\);\s*document\.querySelector\('\.ob-step\[data-step=\"5\"\]'\)\.classList\.add\('active'\);", golive_replacement, html)

# Update signup payload
signup_replacement = """        plan: state.plan,
        bookingUrl: state.bookingUrl,
        businessMode: """
html = html.replace("        plan: state.plan,\n        businessMode:", signup_replacement)

# Remove persona from enterDashboard config
html = re.sub(r"persona:\{name:'Lola',energy:personaEnergy\[state\.persona\],voice:state\.voice\},", "persona:{name:'Lola'},", html)

with open('onboarding.html', 'w') as f:
    f.write(html)
