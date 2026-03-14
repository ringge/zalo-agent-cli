/**
 * Friend commands — list, find, info, add, accept, remove, block, unblock, last-online, online.
 */

import { getApi, autoLogin, clearSession } from "../core/zalo-client.js";
import { success, error, info, warning, output } from "../utils/output.js";

/** Extract numeric error code from zca-js error message string. */
function extractErrorCode(msg) {
    const match = String(msg).match(/\((\-?\d+)\)/);
    return match ? Number(match[1]) : null;
}

export function registerFriendCommands(program) {
    const friend = program.command("friend").description("Manage friends and contacts");

    friend
        .command("list")
        .description("List all friends")
        .action(async () => {
            try {
                const result = await getApi().getAllFriends();
                output(result, program.opts().json, () => {
                    const profiles = result?.changed_profiles || result || {};
                    const entries = Object.entries(profiles);
                    info(`${entries.length} friends`);
                    for (const [uid, p] of entries) {
                        console.log(`  ${uid}  ${p.displayName || p.zaloName || "?"}`);
                    }
                });
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("online")
        .description("List currently online friends")
        .action(async () => {
            try {
                const result = await getApi().getFriendOnlines();
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("find <query>")
        .description("Find user by phone number or Zalo ID")
        .action(async (query) => {
            try {
                const result = await getApi().findUser(query);
                if (!result || (!result.uid && !result?.data?.uid)) {
                    error(
                        `No Zalo user found for "${query}". User may not exist, has disabled phone search, or phone is not registered on Zalo.`,
                    );
                    return;
                }
                output(result, program.opts().json, () => {
                    const u = result?.uid ? result : result?.data || result;
                    info(`User ID: ${u.uid || "?"}`);
                    info(`Name: ${u.displayName || u.zaloName || u.display_name || u.zalo_name || "?"}`);
                });
            } catch (e) {
                error(`Find user failed: ${e.message}`);
            }
        });

    friend
        .command("info <userId>")
        .description("Get user profile information")
        .action(async (userId) => {
            try {
                const result = await getApi().getUserInfo(userId);
                output(result, program.opts().json, () => {
                    const profiles = result?.changed_profiles || {};
                    const p = profiles[userId] || {};
                    info(`Name: ${p.displayName || p.zaloName || "?"}`);
                    info(`Phone: ${p.phoneNumber || "?"}`);
                    info(`Avatar: ${p.avatar || "?"}`);
                });
            } catch (e) {
                error(e.message);
            }
        });

    friend
        .command("add <userId>")
        .description("Send a friend request")
        .option("-m, --msg <text>", "Message to include", "")
        .action(async (userId, opts) => {
            try {
                // zca-js API signature: sendFriendRequest(msg, userId)
                const result = await getApi().sendFriendRequest(opts.msg, userId);
                output(result, program.opts().json, () => success(`Friend request sent to ${userId}`));
            } catch (e) {
                // Map Zalo error codes to actionable messages
                const code = e.code || extractErrorCode(e.message);
                const errMap = {
                    225: `Already friends with ${userId}. Use "friend list" to verify.`,
                    215: `User ${userId} may have blocked you or is unreachable.`,
                    222: `User ${userId} already sent you a friend request. Use "friend accept ${userId}" instead.`,
                    "-1": `Invalid userId "${userId}". Use "friend find <phone>" to get the correct userId first.`,
                };
                error(errMap[code] || `Friend request failed (code ${code}): ${e.message}`);
            }
        });

    friend
        .command("accept <userId>")
        .description("Accept a friend request")
        .action(async (userId) => {
            try {
                const result = await getApi().acceptFriendRequest(userId);
                output(result, program.opts().json, () => success(`Accepted friend request from ${userId}`));
            } catch (e) {
                error(`Accept friend request failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("remove <userId>")
        .description("Remove a friend")
        .action(async (userId) => {
            try {
                const result = await getApi().removeFriend(userId);
                output(result, program.opts().json, () => success(`Removed friend ${userId}`));
            } catch (e) {
                error(`Remove friend failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("block <userId>")
        .description("Block a user")
        .action(async (userId) => {
            try {
                const result = await getApi().blockUser(userId);
                output(result, program.opts().json, () => success(`Blocked user ${userId}`));
            } catch (e) {
                error(`Block user failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("unblock <userId>")
        .description("Unblock a user")
        .action(async (userId) => {
            try {
                const result = await getApi().unblockUser(userId);
                output(result, program.opts().json, () => success(`Unblocked user ${userId}`));
            } catch (e) {
                error(`Unblock user failed for ${userId}: ${e.message}`);
            }
        });

    friend
        .command("last-online <userId>")
        .description("Check when user was last online")
        .action(async (userId) => {
            try {
                const result = await getApi().getLastOnline(userId);
                output(result, program.opts().json);
            } catch (e) {
                error(e.message);
            }
        });

    /** Map FriendEventType enum to readable labels */
    const FRIEND_EVENT_LABELS = {
        0: "FRIEND_ADDED",
        1: "FRIEND_REMOVED",
        2: "FRIEND_REQUEST",
        3: "UNDO_REQUEST",
        4: "REJECT_REQUEST",
        5: "SEEN_REQUEST",
        6: "BLOCKED",
        7: "UNBLOCKED",
        8: "BLOCK_CALL",
        9: "UNBLOCK_CALL",
        10: "PIN_UNPIN",
        11: "PIN_CREATE",
    };

    friend
        .command("listen")
        .description(
            "Listen for friend events: new requests, accepts, removes, blocks. Use --json for machine parsing. Auto-reconnect enabled.",
        )
        .option(
            "-f, --filter <type>",
            "Filter events: request (new requests only), add (accepted only), all (default)",
            "all",
        )
        .option("-w, --webhook <url>", "POST each event as JSON to this URL (for n8n, Make, etc.)")
        .option("--auto-accept", "Automatically accept incoming friend requests")
        .action(async (opts) => {
            const jsonMode = program.opts().json;
            const startTime = Date.now();

            function uptime() {
                const s = Math.floor((Date.now() - startTime) / 1000);
                const h = Math.floor(s / 3600);
                const m = Math.floor((s % 3600) / 60);
                return h > 0 ? `${h}h${m}m` : `${m}m${s % 60}s`;
            }

            async function startListener() {
                try {
                    const api = getApi();

                    api.listener.on("friend_event", async (event) => {
                        const label = FRIEND_EVENT_LABELS[event.type] || "UNKNOWN";

                        // Filter
                        if (opts.filter === "request" && event.type !== 2) return;
                        if (opts.filter === "add" && event.type !== 0) return;

                        const data = {
                            event: label,
                            type: event.type,
                            threadId: event.threadId,
                            isSelf: event.isSelf,
                            data: event.data,
                        };

                        if (jsonMode) {
                            console.log(JSON.stringify(data));
                        } else {
                            const msg =
                                event.type === 2
                                    ? `Friend request from ${event.data.fromUid}: "${event.data.message || ""}"`
                                    : `${label} — ${event.threadId}`;
                            info(msg);
                        }

                        // Webhook
                        if (opts.webhook) {
                            try {
                                await fetch(opts.webhook, {
                                    method: "POST",
                                    headers: { "Content-Type": "application/json" },
                                    body: JSON.stringify(data),
                                });
                            } catch {
                                // Silent
                            }
                        }

                        // Auto-accept friend requests
                        if (opts.autoAccept && event.type === 2 && !event.isSelf) {
                            try {
                                await api.acceptFriendRequest(event.data.fromUid);
                                success(`Auto-accepted friend request from ${event.data.fromUid}`);
                            } catch (e) {
                                error(`Auto-accept failed: ${e.message}`);
                            }
                        }
                    });

                    api.listener.on("closed", async (code, _reason) => {
                        if (code === 3000) {
                            error("Another Zalo Web session opened. Listener stopped.");
                            process.exit(1);
                        }
                        warning(`Connection closed (code: ${code}). Re-login in 5s...`);
                        await new Promise((r) => setTimeout(r, 5000));
                        try {
                            clearSession();
                            await autoLogin(jsonMode);
                            startListener();
                        } catch (e) {
                            error(`Re-login failed: ${e.message}. Retrying in 30s...`);
                            await new Promise((r) => setTimeout(r, 30000));
                            startListener();
                        }
                    });

                    api.listener.start({ retryOnClose: true });

                    info("Listening for friend events... Press Ctrl+C to stop.");
                    info("Auto-reconnect enabled.");
                    if (opts.filter !== "all") info(`Filter: ${opts.filter} events only`);
                    if (opts.webhook) info(`Webhook: POST to ${opts.webhook}`);
                    if (opts.autoAccept) info("Auto-accept: ON — will accept all incoming requests");
                } catch (e) {
                    error(`Listen failed: ${e.message}`);
                    process.exit(1);
                }
            }

            await startListener();

            await new Promise((resolve) => {
                process.on("SIGINT", () => {
                    try {
                        getApi().listener.stop();
                    } catch {}
                    info(`Listener stopped. Uptime: ${uptime()}`);
                    resolve();
                });
            });
        });
}
