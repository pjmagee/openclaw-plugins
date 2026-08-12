"""RPC bridge cog: exposes status / voice / audio controls over Red's official RPC."""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import discord
import lavalink
from lavalink import NodeNotFound, PlayerNotFound
from red_commons.logging import getLogger
from redbot.core import commands
from redbot.core.bot import Red

log = getLogger("red.cogs.OpenClawRpc")


def _track_info(track: Any) -> Optional[Dict[str, Any]]:
    if track is None:
        return None
    title = getattr(track, "title", None) or getattr(track, "label", None) or str(track)
    uri = getattr(track, "uri", None) or getattr(track, "url", None)
    length = getattr(track, "length", None) or getattr(track, "duration", None)
    return {
        "title": title,
        "uri": uri,
        "length_ms": length,
    }


class OpenClawRpc(commands.Cog):
    """Official RPC surface so an OpenClaw agent can control Red (explicit control only)."""

    def __init__(self, bot: Red) -> None:
        self.bot = bot

    async def cog_load(self) -> None:
        for meth in (
            self.status,
            self.voice_status,
            self.join,
            self.leave,
            self.play,
            self.skip,
            self.stop,
            self.now,
        ):
            self.bot.register_rpc_handler(meth)
        log.info("OpenClawRpc RPC handlers registered")

    async def cog_unload(self) -> None:
        for meth in (
            self.status,
            self.voice_status,
            self.join,
            self.leave,
            self.play,
            self.skip,
            self.stop,
            self.now,
        ):
            self.bot.unregister_rpc_handler(meth)

    async def status(self) -> Dict[str, Any]:
        """Bot readiness snapshot for OpenClaw."""
        guilds: List[Dict[str, Any]] = []
        for g in self.bot.guilds:
            guilds.append({"id": str(g.id), "name": g.name, "member_count": g.member_count})
        prefixes: List[str] = []
        try:
            if self.bot.is_ready():
                prefixes = list(await self.bot.get_valid_prefixes())
        except Exception:
            prefixes = []
        return {
            "ok": True,
            "ready": self.bot.is_ready(),
            "user": str(self.bot.user) if self.bot.user else None,
            "user_id": str(self.bot.user.id) if self.bot.user else None,
            "latency_ms": round(self.bot.latency * 1000, 1) if self.bot.latency else None,
            "guild_count": len(self.bot.guilds),
            "guilds": guilds,
            "loaded_cogs": sorted(self.bot.cogs.keys()),
            "prefixes": prefixes,
            "audio_loaded": "Audio" in self.bot.cogs,
        }

    async def voice_status(self, guild_id: int = None) -> Dict[str, Any]:
        """Where Red is connected. Optional guild_id filters to one guild."""
        out: List[Dict[str, Any]] = []
        targets = []
        if guild_id is not None:
            g = self.bot.get_guild(int(guild_id))
            if g:
                targets = [g]
        else:
            targets = list(self.bot.guilds)

        for g in targets:
            entry: Dict[str, Any] = {"guild_id": str(g.id), "guild_name": g.name}
            try:
                player = lavalink.get_player(g.id)
                ch = player.channel
                entry.update(
                    {
                        "connected": True,
                        "channel_id": str(ch.id) if ch else None,
                        "channel_name": ch.name if ch else None,
                        "playing": bool(getattr(player, "current", None)),
                        "paused": bool(getattr(player, "paused", False)),
                        "queue_len": len(getattr(player, "queue", []) or []),
                        "current": _track_info(getattr(player, "current", None)),
                    }
                )
            except (PlayerNotFound, NodeNotFound, IndexError, KeyError):
                entry.update({"connected": False, "channel_id": None, "playing": False})
            out.append(entry)
        return {"ok": True, "voices": out}

    async def join(self, guild_id: int, channel_id: int) -> Dict[str, Any]:
        """Connect Red's Audio/Lavalink player to a voice channel."""
        guild = self.bot.get_guild(int(guild_id))
        if not guild:
            return {"ok": False, "error": "guild_not_found", "guild_id": str(guild_id)}
        channel = guild.get_channel(int(channel_id))
        if channel is None:
            try:
                channel = await self.bot.fetch_channel(int(channel_id))
            except Exception as e:
                return {"ok": False, "error": "channel_not_found", "detail": str(e)}
        if not isinstance(channel, discord.VoiceChannel):
            return {
                "ok": False,
                "error": "not_a_voice_channel",
                "channel_type": type(channel).__name__,
            }
        try:
            player = await lavalink.connect(channel, self_deaf=True)
        except Exception as e:
            log.exception("join failed")
            return {"ok": False, "error": "join_failed", "detail": str(e)}
        return {
            "ok": True,
            "guild_id": str(guild.id),
            "channel_id": str(channel.id),
            "channel_name": channel.name,
            "player": str(player),
        }

    async def leave(self, guild_id: int) -> Dict[str, Any]:
        """Disconnect Red from voice in a guild and clear the queue."""
        guild = self.bot.get_guild(int(guild_id))
        if not guild:
            return {"ok": False, "error": "guild_not_found"}
        try:
            player = lavalink.get_player(guild.id)
        except (PlayerNotFound, NodeNotFound, IndexError, KeyError):
            return {"ok": True, "already_disconnected": True, "guild_id": str(guild.id)}
        try:
            await player.disconnect()
        except Exception as e:
            log.exception("leave failed")
            return {"ok": False, "error": "leave_failed", "detail": str(e)}
        return {"ok": True, "guild_id": str(guild.id), "disconnected": True}

    async def play(
        self, guild_id: int, query: str, channel_id: int = None
    ) -> Dict[str, Any]:
        """Queue/play a URL or search query via Lavalink. Joins channel_id if not connected."""
        query = (query or "").strip()
        if not query:
            return {"ok": False, "error": "query_required"}
        guild = self.bot.get_guild(int(guild_id))
        if not guild:
            return {"ok": False, "error": "guild_not_found"}

        try:
            player = lavalink.get_player(guild.id)
        except (PlayerNotFound, NodeNotFound, IndexError, KeyError):
            if channel_id is None:
                return {
                    "ok": False,
                    "error": "not_connected",
                    "hint": "pass channel_id so Red can join first",
                }
            joined = await self.join(int(guild_id), int(channel_id))
            if not joined.get("ok"):
                return joined
            player = lavalink.get_player(guild.id)

        search = query
        if not query.startswith(("http://", "https://", "ytsearch:", "scsearch:")):
            search = f"ytsearch:{query}"

        try:
            tracks = await player.get_tracks(search)
        except Exception as e:
            log.exception("get_tracks failed")
            return {"ok": False, "error": "search_failed", "detail": str(e), "query": search}

        if not tracks:
            return {"ok": False, "error": "no_tracks", "query": search}

        track = tracks[0]
        requester = self.bot.user
        try:
            player.add(requester, track)
            started = False
            if getattr(player, "current", None) is None:
                await player.play()
                started = True
            elif not getattr(player, "is_playing", True) and not getattr(player, "paused", False):
                await player.play()
                started = True
        except Exception as e:
            log.exception("enqueue/play failed")
            return {"ok": False, "error": "play_failed", "detail": str(e)}

        return {
            "ok": True,
            "started": started,
            "queued": not started,
            "query": search,
            "track": _track_info(track),
            "queue_len": len(getattr(player, "queue", []) or []),
            "channel_id": str(player.channel.id) if player.channel else None,
            "guild_id": str(guild.id),
        }

    async def skip(self, guild_id: int) -> Dict[str, Any]:
        """Skip the current track."""
        try:
            player = lavalink.get_player(int(guild_id))
        except (PlayerNotFound, NodeNotFound, IndexError, KeyError):
            return {"ok": False, "error": "not_connected"}
        prev = _track_info(getattr(player, "current", None))
        try:
            await player.skip()
        except Exception as e:
            return {"ok": False, "error": "skip_failed", "detail": str(e)}
        return {
            "ok": True,
            "skipped": prev,
            "current": _track_info(getattr(player, "current", None)),
            "queue_len": len(getattr(player, "queue", []) or []),
        }

    async def stop(self, guild_id: int, clear_queue: bool = True) -> Dict[str, Any]:
        """Stop playback; optionally clear the queue (default true)."""
        try:
            player = lavalink.get_player(int(guild_id))
        except (PlayerNotFound, NodeNotFound, IndexError, KeyError):
            return {"ok": False, "error": "not_connected"}
        try:
            if clear_queue:
                player.queue.clear()
            await player.stop()
        except Exception as e:
            return {"ok": False, "error": "stop_failed", "detail": str(e)}
        return {
            "ok": True,
            "stopped": True,
            "queue_cleared": bool(clear_queue),
            "guild_id": str(guild_id),
        }

    async def now(self, guild_id: int) -> Dict[str, Any]:
        """Now playing + short queue snapshot."""
        try:
            player = lavalink.get_player(int(guild_id))
        except (PlayerNotFound, NodeNotFound, IndexError, KeyError):
            return {"ok": True, "connected": False, "guild_id": str(guild_id)}
        queue = getattr(player, "queue", []) or []
        return {
            "ok": True,
            "connected": True,
            "guild_id": str(guild_id),
            "channel_id": str(player.channel.id) if player.channel else None,
            "channel_name": player.channel.name if player.channel else None,
            "current": _track_info(getattr(player, "current", None)),
            "paused": bool(getattr(player, "paused", False)),
            "position": getattr(player, "position", None),
            "queue_len": len(queue),
            "queue_preview": [_track_info(t) for t in list(queue)[:8]],
        }
