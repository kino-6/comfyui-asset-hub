import json
from pathlib import Path
import sys

from PIL import Image, ImageDraw, PngImagePlugin


root = Path(sys.argv[1])
root.mkdir(parents=True, exist_ok=True)
image = Image.new('RGB', (768, 512), '#123c53')
draw = ImageDraw.Draw(image)
draw.rectangle((70, 80, 380, 390), fill='#49b2a0')
draw.ellipse((360, 120, 670, 430), fill='#ffd884')
info = PngImagePlugin.PngInfo()
info.add_text('workflow', json.dumps({'last_node_id': 1, 'last_link_id': 0, 'nodes': [{'id': 1, 'type': 'EmptyLatentImage', 'pos': [100, 100], 'size': [315, 106], 'flags': {}, 'order': 0, 'mode': 0, 'inputs': [], 'outputs': [{'name': 'LATENT', 'type': 'LATENT', 'links': None}], 'properties': {}, 'widgets_values': [512, 512, 1]}], 'links': [], 'groups': [], 'config': {}, 'extra': {}, 'version': 0.4}))
info.add_text('prompt', json.dumps({'1': {'class_type': 'EmptyLatentImage', 'inputs': {'width': 512, 'height': 512, 'batch_size': 1}}}))
image.save(root / 'qa-sample.png', pnginfo=info, compress_level=0)
