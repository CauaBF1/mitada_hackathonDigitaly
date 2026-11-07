import json
from functools import wraps

from langgraph.errors import GraphInterrupt
from sqlalchemy import select
from starlette.concurrency import run_in_threadpool

from .database import AgentTrace, SessionLocal
from .scraper_tools import timestamp


def snapshot(state):
    keys = ('request_id', 'generation', 'mode', 'item', 'quantity', 'delivery_location', 'target', 'average', 'tco_base', 'model', 'reply_id', 'done', 'initialized', 'pending_audit', 'audit_feedback', 'discovery_plan')
    data = {key: state[key] for key in keys if key in state}
    for key in ('products', 'approved'):
        if key in state:
            data[key] = [{field: item.get(field) for field in ('supplier_domain', 'product_url', 'price')} for item in state[key]]
    if 'profiles' in state:
        data['profile_domains'] = list(state['profiles'])
    if 'negotiations' in state:
        data['negotiations'] = {domain: {key: current.get(key) for key in ('state', 'round', 'initial_price', 'initial_tco', 'last_tactic')} for domain, current in state['negotiations'].items()}
    return json.dumps(data, ensure_ascii=False, default=str)


def begin(state, node):
    with SessionLocal.begin() as db:
        row = AgentTrace(request_id=state['request_id'], generation=state.get('generation', 1), node=node, status='running', started_at=timestamp(), input_json=snapshot(state))
        db.add(row)
        db.flush()
        return row.id


def finish(identity, status, result=None, error=None):
    with SessionLocal.begin() as db:
        row = db.get(AgentTrace, identity)
        row.status, row.finished_at = status, timestamp()
        row.output_json = snapshot(result) if result is not None else None
        row.error_type = error


def traced(node):
    @wraps(node)
    async def execute(state):
        identity = await run_in_threadpool(begin, state, node.__name__)
        try:
            result = await node(state)
        except GraphInterrupt:
            await run_in_threadpool(finish, identity, 'paused')
            raise
        except Exception as exc:
            await run_in_threadpool(finish, identity, 'failed', None, type(exc).__name__)
            raise
        await run_in_threadpool(finish, identity, 'completed', result)
        return result
    return execute


def read_trace(request_id):
    with SessionLocal() as db:
        return [{'id': row.id, 'request_id': row.request_id, 'thread_id': f'telegram:{row.request_id}:{row.generation}', 'node': row.node, 'status': row.status, 'started_at': row.started_at, 'finished_at': row.finished_at, 'input': json.loads(row.input_json), 'output': json.loads(row.output_json) if row.output_json else None, 'error_type': row.error_type} for row in db.scalars(select(AgentTrace).where(AgentTrace.request_id == request_id).order_by(AgentTrace.id))]
