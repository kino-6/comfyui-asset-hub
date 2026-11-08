import importlib.util
import sys
from pathlib import Path

vendor = Path(__file__).parent / 'vendor' / 'image-browser'
spec = importlib.util.spec_from_file_location(__name__ + '.browser', vendor / '__init__.py', submodule_search_locations=[str(vendor)])
browser = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = browser
spec.loader.exec_module(browser)
from . import hub_api

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}
WEB_DIRECTORY = './web'
