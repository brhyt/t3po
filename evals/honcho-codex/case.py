"""Exercise the pinned Honcho prompt and validator without booting its database."""
import ast
import json
from pathlib import Path
import re
import subprocess
import sys
from datetime import datetime
from inspect import cleandoc
from typing import Any, cast
from pydantic import BaseModel, Field, field_validator

source, output = Path(sys.argv[1]), Path(sys.argv[2])
assert subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip() == '70c67624169683b9e265517aec95a51b8077cabc'
namespace = dict(__name__='honcho_proof', BaseModel=BaseModel, Field=Field, field_validator=field_validator, Any=Any, cast=cast, datetime=datetime, c=cleandoc, _MESSAGE_TAG=re.compile(r'<(?=/?message\b)', re.I))
def load(relative, names):
    path = source / relative
    tree = ast.parse(path.read_text())
    nodes = [node for node in tree.body if isinstance(node, (ast.FunctionDef, ast.ClassDef)) and node.name in names]
    assert len(nodes) == len(names)
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), 'exec'), namespace)
load('src/utils/representation.py', ['ExplicitObservationBase', 'PromptRepresentation'])
load('src/utils/formatting.py', ['custom_instructions_section'])
load('src/deriver/prompts.py', ['format_deriver_message', 'minimal_deriver_prompt'])
representation = namespace['PromptRepresentation']
output.mkdir(parents=True, exist_ok=True)
if len(sys.argv) > 3 and sys.argv[3] == 'validate':
    response_name = sys.argv[4] if len(sys.argv) > 4 else 'response.json'
    result = representation.model_validate_json((output / response_name).read_text())
    assert result.explicit, 'No observations extracted'
    assert all(item.source_indices == [0] for item in result.explicit), 'Incorrect source attribution'
    text = ' '.join(item.content for item in result.explicit).lower()
    assert 'postgres' in text and 'blocked' in text and 'rebuild' in text and 'index' in text
    assert 'mongodb' not in text, 'An unrelated peer statement leaked into the target facts'
    (output / ('validated-' + Path(response_name).stem + '.json')).write_text(result.model_dump_json(indent=2))
    print('PASS: real Honcho validator accepted observations, with correct target evidence.')
else:
    now = datetime(2026, 11, 18, 12)
    messages = '\n'.join([
        namespace['format_deriver_message'](0, 'project', 'project', now, 'We chose PostgreSQL for project memory. The search task is blocked until indexing completes. Our next action is to rebuild the index.'),
        namespace['format_deriver_message'](1, 'other', 'project', now, 'My unrelated project uses MongoDB.'),
    ])
    schema = representation.model_json_schema()
    # Codex strict JSON output requires every object property to be required.
    def strict(value):
        if isinstance(value, dict):
            if value.get('type') == 'object':
                value['additionalProperties'] = False
                value['required'] = list(value.get('properties', {}))
            for child in value.values(): strict(child)
        elif isinstance(value, list):
            for child in value: strict(child)
    strict(schema)
    request = dict(model='account-default', messages=[dict(role='user', content=namespace['minimal_deriver_prompt']('project', messages))], response_format=dict(type='json_schema', json_schema=dict(name='PromptRepresentation', schema=schema)), stream=False)
    (output / 'request.json').write_text(json.dumps(request))
    print('Prepared request from pinned Honcho prompt and schema.')
