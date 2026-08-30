import asyncio
from telnyx import Client

async def handle_tenant_request(tenant_id: str, prompt: str):
    llm_task = asyncio.create_task(stream_llm_response(prompt))
    log_task = asyncio.create_task(log_kiosk_interaction(tenant_id))

    response_audio = await llm_task
    await log_task
    return response_audio
