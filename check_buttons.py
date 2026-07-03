import re

html_content = open("index.html").read()
app_content = open("app.js").read()

# Find all IDs on elements that are buttons or act like buttons
# Let's just find ALL elements with IDs in HTML
ids = re.findall(r'id="([^"]+)"', html_content)
missing = []

for id_str in set(ids):
    # Some IDs might just be containers like 'deck', 'card', 'progressBar'
    # We mainly care about buttons/inputs
    if id_str.endswith("Btn") or id_str.endswith("Input") or id_str.startswith("replay") or id_str in ["reviewBtn", "knownBtn"]:
        if id_str not in app_content:
            missing.append(id_str)

print("Missing in app.js:", missing)
