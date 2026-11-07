import asyncio
import time
from collections import OrderedDict
from urllib.parse import urlsplit
from urllib.robotparser import RobotFileParser


class AccessPolicy:
    cache = OrderedDict()
    next_access = OrderedDict()
    pending = {}

    def __init__(self, fetch):
        self.fetch = fetch

    async def pace(self, url, interval=1.0):
        origin = self.origin(url)
        now = time.monotonic()
        reserved = max(now, self.next_access.get(origin, now))
        self.next_access[origin] = reserved + interval
        self.next_access.move_to_end(origin)
        while len(self.next_access) > 512:
            self.next_access.popitem(last=False)
        if reserved > now:
            await asyncio.sleep(reserved - now)

    @staticmethod
    def origin(url):
        parsed = urlsplit(url)
        return f'{parsed.scheme}://{parsed.netloc}'

    async def allow(self, url):
        from .scraper_tools import ScrapingError
        origin = self.origin(url)
        cached = self.cache.get(origin)
        if cached and cached[0] > time.monotonic():
            robot = cached[1]
        else:
            key = (asyncio.get_running_loop(), origin)
            task = self.pending.get(key)
            if task is None:
                task = asyncio.create_task(self.load_policy(origin))
                self.pending[key] = task
                task.add_done_callback(lambda done: self.pending.pop(key, None))
            robot = await asyncio.shield(task)
        if isinstance(robot, str):
            raise ScrapingError(robot)
        if not robot.can_fetch('NexoProcurement', url):
            raise ScrapingError('O robots.txt do site não permite esta coleta automatizada.')
        delay = robot.crawl_delay('NexoProcurement') or robot.crawl_delay('*')
        if delay:
            if delay > 30:
                raise ScrapingError('Intervalo exigido pelo site excede o orçamento desta consulta.')
            await self.pace(url, max(1.0, delay))

    async def load_policy(self, origin):
        from .scraper_tools import ScrapingError
        ttl = 3600
        try:
            status, headers, text, final = await self.fetch(origin + '/robots.txt')
            robot = RobotFileParser(origin + '/robots.txt')
            if status in {404, 410}:
                robot.parse([])
            elif status == 200 and 'text/html' not in headers.get('Content-Type', headers.get('content-type', '')):
                robot.parse(text.splitlines())
            else:
                raise ScrapingError('Não foi possível verificar a política de acesso automatizado do site.')
        except (ScrapingError, TimeoutError) as error:
            robot = str(error) or 'Tempo limite ao consultar robots.txt; tente novamente em instantes.'
            ttl = 30
        self.cache[origin] = (time.monotonic() + ttl, robot)
        self.cache.move_to_end(origin)
        while len(self.cache) > 512:
            self.cache.popitem(last=False)
        return robot
