// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {TransientSlot} from "@openzeppelin/contracts/utils/TransientSlot.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {CreditPoolV2, IBackerHook} from "./CreditPoolV2.sol";
import {IERC8004Identity} from "./interfaces/IERC8004Identity.sol";

/// @notice A Chainlink feed, as Robinhood Chain publishes one per stock token (docs.robinhood.com/chain/oracles-and-price-feeds).
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80 roundId_, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @notice What a Robinhood stock token (a beacon proxy) exposes, as read on chain on 2026-09-28: the advisory pause it
///         raises while a corporate action is processed, the token's own pause, when its latest multiplier takes (or
///         took) effect, and the access registry (its beacon) that holds the block list. Every read is optional.
interface IStockToken {
    function oraclePaused() external view returns (bool);
    function paused() external view returns (bool);
    function effectiveAt() external view returns (uint256);
    function ACCESS_CONTROLLED_REGISTRY() external view returns (address);
}

/// @notice The registry behind every Robinhood stock token: one pause for all of them and the block list.
interface IAccessRegistry {
    function paused() external view returns (bool);
    function isBlocked(address account) external view returns (bool);
}

/// @notice StockVault's views on the outside world, in a contract of their own so that the vault's code stays under the
///         24 KB limit: its price read (`priceOf`), its lending holds (`lendStatus`), its record bonus (`recordBonus`)
///         and settle's walk over the pool's loans (`walk`). Each StockVault implementation deploys one in its
///         constructor and asks it, with the vault's own settings, for every price, line, loan and default. It holds
///         nothing and has no owner: the price read, the holds and the bonus are the vault's own code, moved here
///         (2026-10-12, the fair default). The one thing it keeps is the price tape (`record`, `tapes`): what every
///         round of a feed answered, read from the feed by whoever records it, so that the price-jump hold compares
///         the latest answer with every round of its window (GHSA-7gq2-77ph-mw6j).
contract StockVaultHolds {
    // StockVault's lendStatus reasons, the same numbers
    uint8 internal constant HOLD_PRICE_MOVED = 1;
    uint8 internal constant HOLD_MULTIPLIER = 2;
    uint8 internal constant HOLD_TOKEN_PAUSED = 3;
    uint8 internal constant HOLD_TOKEN_BLOCKED = 4;
    // more of the window than LIVE_ROUNDS is not on the tape yet: new credit waits (StockVault answers it as
    // HOLD_PRICE_MOVED), and a default waits too until anyone records it, where a price move seizes everything: a tape
    // behind says nothing of the price (GHSA-q29p-rp35-p8v2)
    uint8 internal constant HOLD_TAPE_BEHIND = 5;
    // The price tape keeps each UTC day's lowest, highest and last answer for TAPE_DAYS days, one entry a day: the
    // longest window (14 days) spans 15 days, and its first day is compared with the last answer of the latest day
    // before it with rounds (the price in force when it began), up to 6 days before it (a weekend and three holidays;
    // the stock feeds publish on trading days only; an older one is not compared), so a day's entry is not reused while
    // a window can reach it. A new
    // tape (or a feed's new phase) starts at the first round of the last TAPE_FROM.
    uint256 internal constant TAPE_DAYS = 21;
    uint256 internal constant TAPE_FROM = 20 days;
    // the rounds a hold reads from the feed itself, newest first: those the tape has not recorded yet. A window with
    // more of them than this holds new credit until someone records the feed (the busiest live feeds publish about 650
    // rounds in 14 days, at most about 7 an hour while the market trades).
    uint256 internal constant LIVE_ROUNDS = 6;
    uint256 internal constant DECIMALS_READ_GAS = 50_000; // a token's or feed's decimals(): a beacon proxy's is ~15,000

    /// @dev A UTC day of a feed's rounds on the tape: its lowest and highest answer (`lo` 0: one of them could not be
    ///      read, or was not positive, so the day holds new credit for as long as the window reaches it), and the
    ///      answer of its last round recorded (0: unreadable), read only as the price in force when a window's first
    ///      day begins (in a slot of its own: the window's days read the first one only).
    struct TapeDay {
        uint32 day;
        uint112 lo;
        uint112 hi;
        uint112 last;
    }

    /// @dev A feed's tape: the last round recorded (its proxy round id), and, when the tape began at its phase's first
    ///      round within TAPE_FROM, that round's time (a phase younger than the window holds, as before).
    struct Tape {
        uint80 through;
        uint48 phaseBegan;
    }

    mapping(address feed => Tape) public tapes;
    mapping(address feed => TapeDay[TAPE_DAYS]) internal tapeDays;

    event Recorded(address indexed feed, uint80 fromRound, uint80 throughRound);

    /// @notice Records `feed`'s rounds on its price tape, at most `maxRounds` of them, from the one after the tape's last
    ///         (for a new tape, or a feed whose phase changed, from the first round of the last TAPE_FROM) toward the
    ///         latest. Anyone may call it, any number of times: it only reads the feed, and never records a round twice.
    ///         New credit against a busy feed waits until its tape is less than LIVE_ROUNDS rounds behind (see
    ///         `_priceSettled`), and so does seizing a default (StockVault `_seize`: the default's hook fails, and
    ///         `settle` reverts TapeBehind until it is recorded); repaying and closing never wait on it. A round that
    ///         cannot be read counts from the UTC day it is recorded, however the calls are split. Returns the last
    ///         round recorded.
    function record(address feed, uint256 maxRounds) external returns (uint80) {
        (uint80 latest,,,,) = IPriceFeed(feed).latestRoundData();
        Tape memory t = tapes[feed];
        uint256 next;
        if (t.through != 0 && t.through >> 64 == latest >> 64 && t.through <= latest) {
            if (t.through == latest || maxRounds == 0) return t.through;
            next = uint256(t.through) + 1;
        } else {
            if (maxRounds == 0) return t.through;
            (next, t.phaseBegan) = _tapeStart(feed, latest);
        }
        uint256 end = latest;
        if (end - next >= maxRounds) end = next + maxRounds - 1;
        uint256 cur; // the UTC day being gathered, and its lowest, highest and last answer
        uint256 lo;
        uint256 hi;
        uint256 last;
        for (uint256 id = next; id <= end; ++id) {
            // a round that cannot be read counts from the day it is recorded: never before it was published, and the
            // same day however the calls are split. It took the day of the round before it in the same call (a day
            // before the window, for a new tape's), or today as a call's first (GHSA-q29p-rp35-p8v2)
            uint256 day = block.timestamp / 1 days;
            uint256 a; // 0: a round that cannot be read, or not positive
            try IPriceFeed(feed).getRoundData(uint80(id)) returns (uint80, int256 answer, uint256, uint256 at, uint80) {
                if (at != 0) day = at / 1 days;
                if (answer > 0 && at != 0 && uint256(answer) <= type(uint112).max) a = uint256(answer);
            } catch {}
            if (day != cur) {
                if (cur != 0) _putDay(feed, cur, lo, hi, last);
                (cur, lo, hi, last) = (day, a, a, a);
            } else {
                if (a < lo) lo = a;
                if (a > hi) hi = a;
                last = a;
            }
        }
        _putDay(feed, cur, lo, hi, last);
        tapes[feed] = Tape(uint80(end), t.phaseBegan);
        emit Recorded(feed, uint80(next), uint80(end));
        return uint80(end);
    }

    /// @dev Merges a day's lowest and highest answer into its entry (replacing a day TAPE_DAYS older), and sets its
    ///      last. A day already TAPE_DAYS old (a tape that was not recorded for that long) is out of every window's
    ///      reach and is not kept: its entry is a newer day's.
    function _putDay(address feed, uint256 day, uint256 lo, uint256 hi, uint256 last) internal {
        if (day + TAPE_DAYS <= block.timestamp / 1 days) return;
        TapeDay storage d = tapeDays[feed][day % TAPE_DAYS];
        if (d.day == day) {
            if (d.lo < lo) lo = d.lo;
            if (d.hi > hi) hi = d.hi;
        }
        (d.day, d.lo, d.hi, d.last) = (uint32(day), uint112(lo), uint112(hi), uint112(last));
    }

    /// @dev Where a new tape of `feed` begins, in the phase of its round `latest`: the first round published after
    ///      TAPE_FROM ago (a phase's rounds are numbered in the order they were published: a binary search), and, when
    ///      that is the phase's first round, its time. A round the search cannot read counts as recent, so the tape
    ///      can only begin earlier, never after a round it should hold (the walk forward then records it as a day that
    ///      holds); an unreadable first round counts as published now.
    function _tapeStart(address feed, uint80 latest) internal view returns (uint256 from, uint48 phaseBegan) {
        uint256 phase = uint256(latest) >> 64 << 64;
        uint256 cut = block.timestamp > TAPE_FROM ? block.timestamp - TAPE_FROM : 0;
        uint256 lo = 1;
        uint256 hi = uint64(latest);
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (_publishedAt(feed, phase | mid) > cut) hi = mid;
            else lo = mid + 1;
        }
        from = phase | lo;
        if (lo == 1) {
            uint256 at = _publishedAt(feed, from);
            if (at > cut) phaseBegan = uint48(at);
        }
    }

    /// @dev Round `id`'s time; now for a round that cannot be read.
    function _publishedAt(address feed, uint256 id) internal view returns (uint256) {
        try IPriceFeed(feed).getRoundData(uint80(id)) returns (uint80, int256, uint256, uint256 at, uint80) {
            return at == 0 ? block.timestamp : at;
        } catch {
            return block.timestamp;
        }
    }

    /// @notice 0 when `vault` may give new credit against `token`, priced by `feed`; otherwise the first hold that
    ///         applies (see StockVault.lendStatus), with the vault's own `seizeTo` and price guard, or HOLD_TAPE_BEHIND
    ///         (5: the feed's tape must be recorded first, `record`; StockVault answers it as HOLD_PRICE_MOVED). Every
    ///         read is a bounded static call: a token or registry without the function holds nothing back.
    function lendStatus(
        address vault,
        address token,
        address feed,
        address seizeTo,
        uint256 multiplierCooldown,
        uint256 maxJumpBps,
        uint256 jumpWindow
    ) external view returns (uint8) {
        if (_flag(token, abi.encodeCall(IStockToken.paused, ()))) return HOLD_TOKEN_PAUSED;
        address reg = token;
        (bool ok, uint256 w) = _read(token, abi.encodeCall(IStockToken.ACCESS_CONTROLLED_REGISTRY, ()));
        if (ok && address(uint160(w)) != address(0)) reg = address(uint160(w));
        if (reg != token && _flag(reg, abi.encodeCall(IAccessRegistry.paused, ()))) return HOLD_TOKEN_PAUSED;
        if (
            _flag(reg, abi.encodeCall(IAccessRegistry.isBlocked, (vault)))
                || _flag(reg, abi.encodeCall(IAccessRegistry.isBlocked, (seizeTo)))
        ) return HOLD_TOKEN_BLOCKED;
        (ok, w) = _read(token, abi.encodeCall(IStockToken.effectiveAt, ()));
        uint256 effectiveAt = ok ? w : 0;
        if (effectiveAt != 0 && (effectiveAt > block.timestamp || block.timestamp - effectiveAt < multiplierCooldown)) {
            return HOLD_MULTIPLIER;
        }
        return _feedHold(feed, effectiveAt, maxJumpBps, jumpWindow);
    }

    /// @notice One page of a defaulted position's walk over `pool`'s loans (StockVault.settle): loans `next` to
    ///         `end` - 1, at most `max` of them; of those that are agent `id`'s and that `root` backed, the principal +
    ///         fee of the ones that defaulted, as the pool stored them (`owed`). Stops before one still active
    ///         (`active`: the debt is not final). With `end` 0 the walk begins: from the first loan issued at or after
    ///         `openedAt` (the position's opening) to the last issued at or before `lastBorrowAt` (the agent's last
    ///         borrow; a defaulted agent never borrows again), found by binary search. Returns where it stopped and the
    ///         walk's end.
    function walk(
        CreditPoolV2 pool,
        uint256 id,
        uint256 root,
        uint256 openedAt,
        uint256 lastBorrowAt,
        uint256 next,
        uint256 end,
        uint256 max
    ) external view returns (uint256, uint256, uint256 owed, bool active) {
        if (end == 0) (next, end) = (_loanAt(pool, openedAt), _loanAt(pool, lastBorrowAt + 1));
        uint256 to = end - next > max ? next + max : end;
        for (; next < to; ++next) {
            CreditPoolV2.Loan memory l = pool.getLoan(next);
            if (l.agentId != id || l.sponsorId != root) continue;
            if (l.status == CreditPoolV2.LoanStatus.Active) return (next, end, owed, true);
            if (l.status == CreditPoolV2.LoanStatus.Defaulted) owed += l.principal + l.fee;
        }
        return (next, end, owed, false);
    }

    /// @dev The first of `pool`'s loans issued at or after `t` (loanCount() + 1 when none): a binary search, the pool's
    ///      loans being numbered in the order they were issued. At most ~log2(loanCount()) reads.
    function _loanAt(CreditPoolV2 pool, uint256 t) internal view returns (uint256 lo) {
        lo = 1;
        uint256 hi = pool.loanCount() + 1;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (pool.getLoan(mid).issuedAt >= t) hi = mid;
            else lo = mid + 1;
        }
    }

    /// @notice StockVault.recordBonusBps, moved here verbatim (2026-10-12, to keep the vault under 24 KB), with the
    ///         vault's settings: `bpsPerStep` for every `feeStep` of fees agent `id` paid on repaid loans the `roots`
    ///         backed (`pool`'s feesFrom), at most `maxBonus`; the vault's own root `own` never counts.
    function recordBonus(
        CreditPoolV2 pool,
        uint256[] calldata roots,
        uint256 own,
        uint256 id,
        uint256 feeStep,
        uint256 bpsPerStep,
        uint256 maxBonus
    ) external view returns (uint256) {
        uint256 step = feeStep;
        uint256 per = bpsPerStep;
        uint256 cap = maxBonus;
        if (step == 0 || per == 0 || cap == 0) return 0;
        uint256 paid;
        uint256 n = roots.length;
        for (uint256 i; i < n; ++i) {
            uint256 root = roots[i];
            if (root != own) paid += pool.feesFrom(root, id);
        }
        uint256 steps = paid / step;
        if (steps >= cap / per + 1) return cap;
        uint256 bonus = steps * per;
        return bonus < cap ? bonus : cap;
    }

    /// @dev The feed's side of the holds. HOLD_MULTIPLIER while the token's multiplier took effect after the feed's
    ///      latest answer (the feed has not caught up: its price is still per the old share count). HOLD_PRICE_MOVED
    ///      unless the latest answer is within `maxJumpBps` of every round of the last `jumpWindow` (see
    ///      `_priceSettled`): a jump anywhere in the window (the first round of a split the feed's multiplier lags, and
    ///      every round after it until the multiplier catches up, or a move that has since reverted) holds new credit.
    ///      A round that cannot be read, or a feed younger than the window (a new phase) holds it too: history that
    ///      cannot be checked is not trusted. A window with more rounds than LIVE_ROUNDS that the tape has not recorded
    ///      is HOLD_TAPE_BEHIND: anyone records it (`record`), and the vault answers it as HOLD_PRICE_MOVED but for a
    ///      default, which waits for it.
    function _feedHold(address feed, uint256 effectiveAt, uint256 maxJumpBps, uint256 jumpWindow)
        internal
        view
        returns (uint8)
    {
        uint80 id;
        uint256 price;
        try IPriceFeed(feed).latestRoundData() returns (uint80 r, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return HOLD_PRICE_MOVED;
            if (effectiveAt > updatedAt) return HOLD_MULTIPLIER;
            (id, price) = (r, uint256(answer));
        } catch {
            return HOLD_PRICE_MOVED;
        }
        return _priceSettled(feed, id, price, maxJumpBps, jumpWindow);
    }

    /// @dev The jump check of `_feedHold`, from the latest round `id` at `price`: 0 (settled) when no round of the
    ///      last `jumpWindow` answered more than `maxJumpBps` away from `price` (as a share of that round's answer).
    ///      Every round counts: the walk this replaces read the rounds 1, 2, 4 … 4,096 back only, and settled at the
    ///      first of them published before the window, so a round between two of them was never compared
    ///      (GHSA-7gq2-77ph-mw6j). The rounds the feed's tape has not recorded are read from the feed, newest first, at
    ///      most LIVE_ROUNDS of them, down to the first one published at or before the window (compared too, as
    ///      before); more than that is HOLD_TAPE_BEHIND. The older ones are compared through the tape, each UTC day of
    ///      the window by its lowest and highest answer, and the price in force when its first day began (as the live
    ///      walk compares the round in force when the window opens) by the last answer of the latest day before it on
    ///      the tape (GHSA-q29p-rp35-p8v2: with the tape through the round before the latest, that round was never
    ///      compared), when the tape reaches it (a feed silent for more than the TAPE_DAYS the window leaves, about 6
    ///      days, before the window: not compared, as before). A day counts whole: a round holds new credit until `jumpWindow`
    ///      after the end of its UTC day (and, as the last of its day, while it is the price in force when a window's
    ///      first day begins). With `jumpWindow` 0, the round before the latest is the only one compared, as before.
    function _priceSettled(address feed, uint80 id, uint256 price, uint256 maxJumpBps, uint256 jumpWindow)
        internal
        view
        returns (uint8)
    {
        uint256 since = block.timestamp > jumpWindow ? block.timestamp - jumpWindow : 0;
        Tape memory t = tapes[feed];
        // the tape's last round, if it is this phase's (a Chainlink proxy's round id is phase << 64 | its round); with
        // no window, the round before the latest is read from the feed instead (and is the only one compared)
        uint256 taped = jumpWindow != 0 && t.through >> 64 == id >> 64 && t.through <= id ? t.through : 0;
        uint256 k = id;
        for (uint256 i;; ++i) {
            if (uint64(k) == 1) return HOLD_PRICE_MOVED; // no round before this one in the phase, still in the window
            --k;
            if (k <= taped) break; // the rest is on the tape
            if (i == LIVE_ROUNDS) return HOLD_TAPE_BEHIND; // more of the window than is read here, not on the tape
            try IPriceFeed(feed).getRoundData(uint80(k)) returns (uint80, int256 old, uint256, uint256 at, uint80) {
                if (old <= 0 || at == 0) return HOLD_PRICE_MOVED;
                if (_moved(price, uint256(old), maxJumpBps)) return HOLD_PRICE_MOVED;
                if (at <= since) return 0; // every older round is outside the window
            } catch {
                return HOLD_PRICE_MOVED;
            }
        }
        if (t.phaseBegan > since) return HOLD_PRICE_MOVED; // the tape began at its phase's first round, in the window
        uint256 today = block.timestamp / 1 days;
        uint256 d = since / 1 days;
        for (uint256 e = d; e <= today; ++e) {
            TapeDay storage b = tapeDays[feed][e % TAPE_DAYS];
            if (b.day == e && (_moved(price, b.lo, maxJumpBps) || _moved(price, b.hi, maxJumpBps))) {
                return HOLD_PRICE_MOVED;
            }
        }
        while (d != 0 && d + TAPE_DAYS > today + 1) {
            TapeDay storage b = tapeDays[feed][--d % TAPE_DAYS];
            if (b.day == d) return _moved(price, b.last, maxJumpBps) ? HOLD_PRICE_MOVED : 0;
        }
        return 0;
    }

    /// @dev `price` is more than `maxJumpBps` away from `old`, as a share of `old` (always, for an `old` of 0).
    function _moved(uint256 price, uint256 old, uint256 maxJumpBps) internal pure returns (bool) {
        uint256 diff = price > old ? price - old : old - price;
        return diff * 10_000 > old * maxJumpBps;
    }

    /// @notice StockVault's price read (`_valueOf`), moved here verbatim (2026-10-12, to keep the vault under 24 KB),
    ///         with the asset's settings as StockVault holds them: `feed`'s answer for `token` (in the feed's
    ///         decimals), `ok` only if positive, not in the future, fresh (`maxAge`, `sessionMaxAge` and the week's
    ///         last price: see StockVault's notice), in the decimals `setAsset` read from the feed (`feedDecimals`),
    ///         for a token that still answers the decimals `setAsset` read from it (`tokenDecimals`), and while the
    ///         token does not flag its oracle as paused (the flag is advisory: a token without it passes); (false, 0)
    ///         otherwise, never a revert.
    function priceOf(
        address token,
        address feed,
        uint256 maxAge,
        uint256 feedDecimals,
        uint256 tokenDecimals,
        uint256 sessionMaxAge
    ) external view returns (bool ok, uint256 price) {
        try IPriceFeed(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (
                answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp
                    || !_fresh(updatedAt, maxAge, sessionMaxAge)
            ) return (false, 0);
            price = uint256(answer);
        } catch {
            return (false, 0);
        }
        // a Chainlink proxy answers in its current aggregator's decimals: one its owner moved to another precision
        // would be priced on the old scale (8 to 18 decimals: 10^10 times the value). Nothing is priced until the
        // owner's setAsset reads the feed again (GHSA-rwj3-gr68-p93p)
        (bool okF, uint8 fdec) = _decimalsOf(feed);
        if (!okF || fdec != feedDecimals) return (false, 0);
        // the token's own scale, the other half of it: a stock token is a beacon proxy, and an implementation its
        // issuer installs in another precision would be priced on the old one (18 to 24 decimals: 10^6 times the
        // value), with no hold to catch it. Nothing is priced until the owner's setAsset reads the token again
        // (GHSA-855q-24q2-qwph)
        (bool okT, uint8 tdec) = _decimalsOf(token);
        if (!okT || tdec != tokenDecimals) return (false, 0);
        try IStockToken(token).oraclePaused() returns (bool paused_) {
            if (paused_) return (false, 0);
        } catch {}
        return (true, price);
    }

    /// @dev `decimals()` read so that it fails closed: at most DECIMALS_READ_GAS, exactly one word back (no more is
    ///      copied), at most 255. Anything else, a token or feed that cannot answer, is (false, 0), never a revert and
    ///      never the borrow hook's whole budget (the fix's audits, 2026-10-11).
    function _decimalsOf(address target) internal view returns (bool ok, uint8 d) {
        if (target.code.length == 0) return (false, 0);
        uint256 g = DECIMALS_READ_GAS;
        uint256 word;
        assembly ("memory-safe") {
            mstore(0, 0x313ce56700000000000000000000000000000000000000000000000000000000) // decimals()
            ok := staticcall(g, target, 0, 4, 0, 0x20)
            ok := and(ok, eq(returndatasize(), 32))
            if ok { word := mload(0) }
        }
        if (!ok || word > type(uint8).max) return (false, 0);
        d = uint8(word);
    }

    /// @dev See StockVault's notice: at most `sessionMaxAge` old, or the week's last price (published on a Friday or
    ///      Saturday, UTC) until Tuesday 06:00 UTC; never older than `maxAge`.
    function _fresh(uint256 updatedAt, uint256 maxAge, uint256 sessionMaxAge) internal view returns (bool) {
        uint256 age = block.timestamp - updatedAt;
        if (age > maxAge) return false;
        if (age <= sessionMaxAge) return true;
        uint256 day = updatedAt / 1 days;
        uint256 weekday = (day + 4) % 7; // 0 Sunday … 5 Friday, 6 Saturday (1 January 1970 was a Thursday)
        if (weekday < 5) return false;
        uint256 tuesday = day + (weekday == 5 ? 4 : 3);
        return block.timestamp < tuesday * 1 days + 6 hours;
    }

    /// @dev A static call that answered at least one word: (true, that word); anything else: (false, 0).
    function _read(address target, bytes memory data) internal view returns (bool ok, uint256 word) {
        if (target.code.length == 0) return (false, 0);
        assembly ("memory-safe") {
            ok := staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0x20)
            ok := and(ok, gt(returndatasize(), 31))
            if ok { word := mload(0) }
        }
    }

    function _flag(address target, bytes memory data) internal view returns (bool) {
        (bool ok, uint256 w) = _read(target, data);
        return ok && w != 0;
    }
}

/// @title StockVault
/// @notice Borrow against Robinhood stock tokens. An agent's owner deposits accepted stock tokens; the vault, a root
///         backer with its own ERC-8004 identity and its own USDG stake in CreditPoolV2, vouches that agent a line
///         worth `ltvOf(agent, token)` of the deposit's value at its Chainlink price. The tokens are the line's
///         collateral for exactly as long as the line is open.
///
///         The loan-to-value is the stock's own (`Asset.ltvBps`, set with the token in `setAsset`: steadier stocks
///         lend more), plus a record bonus (`recordBonusBps`): the better the agent's record of repaying
///         credit someone else took the risk on, the less collateral it needs. The record is read from the pool's
///         per-sponsor fee ledger (`feesFrom[root][agent]`) of the trusted roots only: fees the agent paid on loans
///         those backers funded and it repaid. Only roots whose risk the agent's owner cannot take on itself belong
///         in the list (the treasury; not a seat vault, where an owner can seat its own agent with its own tokens and
///         get the fees back). Loans on this vault's own lines never count (they are the agent's own collateral). The
///         bonus scales with the stock's own loan-to-value (a riskier stock gains less), and the total never passes
///         MAX_LTV_BPS. The record belongs to the agent: whoever holds it when a position opens gets its bonus.
///
///           open(agent, token, amount, c, sig)  the agent's owner or pool delegate deposits `amount` of `token` and
///                                               forwards the owner's signed pool consent: the vault vouches the line.
///           addCollateral(agent, amount)        the depositor adds more of the same token (a higher borrow limit).
///           close(agent)                        depositor or controller: the line freezes; with no loan open every
///                                               token goes back now, otherwise when the last loan is repaid.
///           expire(agent)                       anyone, once a position has had no loan for `idleAfter` since its
///                                               last loan or repayment (`idleUndrawnAfter` for a line never drawn):
///                                               it closes and every token goes back, so idle lines do not hold the
///                                               stake.
///           default                             the pool tells the vault (onDefault, onRelease): once the agent's last
///                                               loan has ended, its debt plus a buffer is seized, sent to `seizeTo`,
///                                               and the rest goes back to the depositor (see "A default" below).
///           settle(agent, loanId)               the manual path for any of the above, if a hook call ever failed (a
///           reconcile(agent, maxLoans)          default's debt summed from the pool's loans, in bounded pages).
///           writeOff(agent) / reclaim(agent)    the owner ends the line of a position whose token cannot be sent
///                                               back; the tokens stay owed to the depositor until they move again.
///                                               A default's rest that cannot be sent is owed the same way.
///
///         A default seizes exactly what the vault's root lost for the agent, `owed`, plus `seizeBufferOf(token)` of it
///         (20% unless the owner sets the vault's or the token's own, 10% to 100%), at the price the vault would lend
///         against now: ceil(owed × (1 + buffer) / price) tokens (at most one base unit over the exact quotient, the
///         funder's favour), at most what the position is paid (_payout), to `seizeTo`, and every other token back to
///         the depositor. `owed` is the principal and fee, as the pool stored them, of every loan this vault backed on
///         the position since it opened that defaulted (a repaid one owes nothing). It is final only once the agent has
///         no loan left, so that is when the position is seized: by onRelease, when the pool releases a defaulted
///         agent's residual line (its last loan defaulted, in that same transaction, or was repaid), or by settle
///         (reconcile), a page of the pool's loans at a time, once it has read them all.
///         Until then the whole deposit stays, and close() refuses a defaulted agent. onRelease seizes for the debt
///         onDefault summed, loan by loan, only when it accounts for the whole line with the residual line and the
///         undrawn line the pool gave back; otherwise (a hook that failed or was skipped) the position waits for
///         settle, which sums the pool's loans again from scratch. Everything is seized, as before, when the price is
///         not one the vault lends against now (stale, the oracle paused, a lending hold: a price move, a multiplier
///         change, the token paused or this vault or `seizeTo` blocked), the deposit is worth less than owed plus the
///         buffer, or the token's and its
///         feed's decimals add up to fewer than 6 (none accepted today). A price tape behind (more of the window than
///         the hold reads live: see lendStatus) is not a price that cannot be used: the seizure waits for it, the
///         default's hook fails with the whole deposit kept, and `settle` reverts TapeBehind(feed) until anyone records
///         the feed (`holds().record(feed, n)`), then seizes as above (GHSA-q29p-rp35-p8v2). A rest that cannot be sent in that call (the
///         issuer blocked the depositor, or the hook's gas does not reach it: the pool gives a hook 300,000, and the
///         price checks of a busy feed take much of it) never reverts the hook: it stays owed, in `held` and out of
///         `rescue`'s reach, as a written-off position's tokens (`closing` marks a default's), and goes out with
///         anyone's `reclaim` (or a later onRelease about the agent), once the token moves; the position then reads
///         Seized again. A seizure the token will not make at
///         all (paused) fails the hook as before; `settle` seizes once it moves.
///
///         Every new loan asks the vault (canBorrow): it is refused unless the price is fresh, the token's oracle is not
///         paused, no lending hold applies (lendStatus), the agent still belongs to the owner who opened the
///         position, and the agent's drawn principal plus the new loan stays within `ltvOf(agent, token)` of the
///         collateral's value now. A falling price therefore shrinks what can be drawn; loans already open are untouched.
///
///         Lending holds, for new lines and new loans (repaying and closing never wait on them; a default's seizure
///         takes everything on one, see above, and waits only for a price tape behind): the
///         feed's answer moved more than `maxJumpBps` against any round of the last `jumpWindow` (a reverse split
///         the feed's multiplier has not caught up with yet shows as one), or that history is not on the feed's price
///         tape and too long to read in the call (anyone records it: `holds().record(feed, n)`); the token's
///         multiplier changes, or changed
///         within `multiplierCooldown`; the token or its registry is paused; the registry blocks this vault or
///         `seizeTo`, so a default could not seize.
///
///         An issuer burn from the vault is shared: when the vault holds less of a token than it owes, every
///         position of that token gets the same share of its amount back (or seized). Until that shortfall is paid
///         out, the token takes no new collateral (`open` and `addCollateral` revert `Shortfall`), so a later deposit
///         never pays it, and every loan is sized on that share of the amount, not on the amount.
///
///         Fresh: at most `sessionMaxAge` old (the feeds publish at least daily while the market trades), or, for the
///         week's last price (published on a Friday or Saturday, UTC), until Tuesday 06:00 UTC: the market is closed
///         over the weekend and a Monday holiday. Never older than the asset's `maxAge`. A stock that stops trading
///         mid-week (a halt) stops being lent against within `sessionMaxAge`.
///
///         Every line keeps room in the stake for the largest fee it can lock (the pool's fee over its longest term),
///         so a loan up to any open line always finds the backing its fee needs.
///
///         Who carries what: the vault funder's USDG (the root's stake) backs every line 100%, as every line on the
///         pool is backed; a default is paid from it, and the seized stock, worth what it cost plus the buffer, goes to
///         `seizeTo` (the funder) to make up for it. Lenders never carry the risk. The owner can pause, retune future
///         terms and freeze a position (every token back to its depositor), but can never take a depositor's tokens
///         except through a default, short of an upgrade.
///
///         Upgradable: the vault is a Transparent ERC-1967 proxy (StockVaultProxy) to this implementation. The proxy's
///         address is the vault (the pool's root hook, the identity's owner, the tokens' holder) and keeps its state;
///         its ProxyAdmin, owned by the Safe, alone can point it at a new implementation (`upgradeAndCall`), to fix it
///         or to move what it holds. A new implementation keeps this storage layout and only appends to it, and is
///         constructed with the same pool.
contract StockVault is Ownable2Step, Initializable, IERC721Receiver, IBackerHook {
    using SafeERC20 for IERC20;
    using TransientSlot for *;

    uint256 internal constant MAX_LTV_BPS = 7000; // a line is never more than 70% of its collateral's value
    uint256 internal constant MIN_LTV_BPS = 1000; // an accepted token's own LTV is at least 10%
    uint256 internal constant MAX_BONUS_BPS = 2000; // the record adds at most 20 points of loan-to-value
    uint256 internal constant MAX_TRUSTED_ROOTS = 4; // bounds the record read on every loan (canBorrow)
    uint256 internal constant MIN_BONUS_FEE_STEP = 1000; // 0.001 USDG: a step is never a rounding error
    uint64 internal constant MAX_PRICE_AGE = 7 days;
    uint64 internal constant MAX_EPOCH = 365 days;
    uint256 internal constant MAX_ASSETS = 100; // bounds assetList()
    uint256 internal constant MAX_JUMP_BPS = 5000; // the loosest price-jump bound the owner can set (a 1:2 split is 10000)
    uint256 internal constant MIN_JUMP_BPS = 500;
    uint64 internal constant MAX_GUARD_WINDOW = 14 days;
    uint256 internal constant DEFAULT_SEIZE_BUFFER_BPS = 2000; // a default keeps what is owed plus 20% (seizeBufferBps)
    uint256 internal constant MIN_SEIZE_BUFFER_BPS = 1000;
    uint256 internal constant MAX_SEIZE_BUFFER_BPS = 10_000;
    // kept back from a default's transfer of the rest to its depositor, so that a transfer that fails (or burns all the
    // gas it is given) still leaves the hook enough to record the rest as owed (about 8,000: warm writes, an event)
    uint256 internal constant RETURN_GAS_RESERVE = 20_000;
    uint256 internal constant SETTLE_PAGE = 200; // the pool's loans one settle() reads at most (reconcile: its own)
    // lendStatus reasons (0: no hold)
    uint8 public constant HOLD_PRICE_MOVED = 1;
    uint8 public constant HOLD_MULTIPLIER = 2;
    uint8 public constant HOLD_TOKEN_PAUSED = 3;
    uint8 public constant HOLD_TOKEN_BLOCKED = 4;
    // StockVaultHolds' own reason, answered as HOLD_PRICE_MOVED: the price tape is behind (a default waits for it)
    uint8 internal constant HOLD_TAPE_BEHIND = 5;
    bytes32 internal constant LOCK = keccak256("priors.stockvault.v1.lock");

    enum Status {
        None,
        Open,
        Closed,
        Seized,
        WrittenOff // the line ended by writeOff, or a default whose rest could not be sent yet (`closing` set: reclaim
        // then leaves it Seized); the tokens are still owed to the depositor (reclaim)
    }

    struct Asset {
        address feed; // Chainlink price feed of the token, in USD
        uint64 maxAge; // a price older than this is not used
        uint8 tokenDecimals;
        uint8 feedDecimals;
        bool enabled; // accepted for new positions (existing ones keep being priced while the feed is set)
        uint16 ltvBps; // this token's line, and borrow limit, as a share of its value (MIN_LTV_BPS..MAX_LTV_BPS)
        uint128 lineCap; // USDG of open lines this token may back, all positions together (0: no new line)
    }

    struct Params {
        uint256 ltvBps; // the reference LTV the record bonus scales against (each token carries its own: Asset.ltvBps)
        uint256 maxLine; // USDG, per position
        uint256 epochCap; // USDG of new lines per epoch, all positions combined
        uint64 epochLength; // seconds
    }

    struct Position {
        address depositor; // who put the tokens in, and gets them back
        address owner; // the agent's owner when the position opened: loans stop if the agent changes hands
        address token;
        uint64 openedAt;
        bool closing; // the line is frozen; the position closes when the last loan does
        Status status;
        uint128 line; // USDG vouched at opening
        uint256 amount; // tokens held for this position
    }

    struct Debt {
        uint128 owed; // principal + fee of the position's loans that defaulted, as the pool stored them (USDG)
        uint128 principal; // their principal alone: with the line the pool still vouches, it must make up the line
    }

    struct Recon {
        uint64 next; // settle's walk over the pool's loans: the next one to read
        uint64 end; // one past the last that can be the position's (0: not begun)
        uint128 owed; // what the loans read so far add up to
    }

    CreditPoolV2 public immutable pool;
    IERC20 public immutable usdg;
    IERC8004Identity public immutable registry;
    StockVaultHolds public immutable holds; // its holds, debt walk and price tape (StockVaultHolds), deployed with this code

    uint256 public agentId; // the vault's own ERC-8004 identity (its root), once adopted
    address public seizeTo; // where seized collateral goes (the funder that pays the default)
    address public feeSink; // where the root's sponsor fees go
    bool public paused; // stops new positions and new loans; closing, settling and claiming always work
    Params public params;
    uint64 public epochStart;
    uint256 public linedThisEpoch;
    uint256 public openLines; // USDG vouched to open positions, all together
    // (the defaults below are set by initialize: a proxy never runs the implementation's initializers)
    uint64 public sessionMaxAge; // 26 hours: a price older than this is stale, except the week's last one (see above)
    uint64 public idleAfter; // 30 days: a position with no loan for this long can be expired by anyone
    uint64 public idleUndrawnAfter; // 7 days: the same for a line never drawn (never longer than idleAfter)
    uint16 public maxJumpBps; // 25%: new credit waits while the price moved more than this within jumpWindow
    // 14 days: longer than the 7 days SGOV's feed once lagged its multiplier (3 to 10 August), so a reverse split's
    // inflated price is held for the whole lag (readiness review 2026-09-28, V2)
    uint64 public jumpWindow;
    uint64 public multiplierCooldown; // 1 day: new credit waits this long after a token's multiplier changes

    mapping(address => Asset) public assets;
    address[] internal _assetList;
    mapping(uint256 => Position) internal positions; // agentId => its current (or last) position (read: getPosition)
    mapping(address => uint256) public held; // token => collateral owed back to depositors (open positions)
    mapping(address => uint256) public openLinesOf; // token => USDG of open lines it backs (against Asset.lineCap)
    uint256[] internal _trustedRoots; // roots whose repaid loans make the record (never this vault's own)
    uint256 public bonusFeeStep; // USDG of fees paid under trusted roots per step of bonus
    uint16 public bonusBpsPerStep; // loan-to-value added per step
    uint16 public maxBonusBps; // the most the record adds
    // appended after the 2026-09-30 layout: a close requested with a loan open keeps its epoch refund until the last
    // repayment ends the position (onRelease); written by the first deferred request, cleared by any eviction
    mapping(uint256 => bool) internal closeRefund;
    // appended after the 2026-10-11 layout (the fair default): the buffer a default keeps on top of what is owed, per
    // token (address(0): the vault's own; 0 falls back to the vault's, then to DEFAULT_SEIZE_BUFFER_BPS: no
    // reinitializer); per position, the undrawn line the pool gave back while it stayed open (a close request's freeze,
    // and each repayment after it), and the debt onDefault summed. Both reset when a position opens, and read only to
    // seize it: `released` only to check that the summed debt accounts for the whole line (_endDefault)
    mapping(address => uint16) internal seizeBuffer;
    mapping(uint256 => uint256) internal released;
    mapping(uint256 => Debt) internal debt;
    // settle's walk, page by page, over the pool's loans that can be a defaulted position's (reset when one opens)
    mapping(uint256 => Recon) internal recon;

    event Adopted(uint256 indexed agentId);
    event Funded(address indexed from, uint256 amount);
    event Retired(uint256 shares, uint256 assets, address indexed to);
    event AssetSet(
        address indexed token, address indexed feed, uint64 maxAge, bool enabled, uint16 ltvBps, uint128 lineCap
    );
    event Opened(
        uint256 indexed agentId,
        address indexed depositor,
        address indexed token,
        uint256 amount,
        uint256 value,
        uint256 line
    );
    event CollateralAdded(uint256 indexed agentId, address indexed from, uint256 amount);
    event CloseRequested(uint256 indexed agentId, address indexed by);
    event Closed(uint256 indexed agentId, address indexed depositor, uint256 returned);
    event Seized(uint256 indexed agentId, address indexed to, address indexed token, uint256 amount);
    /// A default's rest: `amount` of the token beyond what covers `owed` (USDG, 6 decimals) plus `bufferBps`, priced at
    /// `price` (the feed's answer, in its decimals), back to `depositor` (`sent`), or owed until `reclaim` sends it.
    /// The position is seized, not closed.
    event Returned(
        uint256 indexed agentId,
        address indexed depositor,
        address indexed token,
        uint256 amount,
        uint256 owed,
        uint256 price,
        uint256 bufferBps,
        bool sent
    );
    event SeizeBufferSet(address indexed token, uint16 bufferBps);
    event PositionFrozen(uint256 indexed agentId, address indexed by);
    event ParamsUpdated(Params params);
    event Paused(bool paused);
    event SeizeToUpdated(address indexed seizeTo);
    event FeeSinkUpdated(address indexed feeSink);
    event Skimmed(uint256 amount, address indexed to);
    event Rescued(address indexed token, address indexed to, uint256 amount);
    event Expired(uint256 indexed agentId);
    event SessionMaxAgeUpdated(uint64 sessionMaxAge);
    event IdleAfterUpdated(uint64 idleAfter);
    event IdleUndrawnAfterUpdated(uint64 idleUndrawnAfter);
    event PriceGuardUpdated(uint16 maxJumpBps, uint64 jumpWindow, uint64 multiplierCooldown);
    event WrittenOff(uint256 indexed agentId, address indexed token, uint256 amount);
    event UsdgRescued(address indexed to, uint256 amount);
    event RecordBonusUpdated(uint256[] trustedRoots, uint256 feeStep, uint16 bpsPerStep, uint16 maxBonusBps);

    error Reentrancy();
    error NotAdopted();
    error AlreadyAdopted();
    error NotOurs(uint256 agentId);
    error VaultPaused();
    error ZeroAmount();
    error NotController(uint256 agentId, address caller);
    error NotEligible(uint256 agentId);
    error PositionOpen(uint256 agentId);
    error NoPosition(uint256 agentId);
    error AssetNotAccepted(address token);
    error PriceUnavailable(address token);
    error LineTooSmall(uint256 line, uint256 minLoan);
    error EpochCapReached(uint256 wanted, uint256 left);
    error BadTransfer(uint256 expected, uint256 received);
    error NotDepositorOrController(uint256 agentId, address caller);
    error AgentDefaulted(uint256 agentId);
    error StillBacked(uint256 agentId);
    error BadProof(uint256 agentId, uint256 loanId);
    error InvalidParams();
    error Protected(address token);
    error NotDepositor(uint256 agentId, address caller);
    error NoFeeRoom(uint256 needed, uint256 free);
    error NotIdle(uint256 agentId);
    error LendingHeld(address token, uint8 reason);
    error LoanOpen(uint256 agentId);
    error NotSent(uint256 agentId);
    error Renounce();
    error TokensOwed(uint256 agentId);
    error TokenCapReached(address token, uint256 wanted, uint256 left);
    error Shortfall(address token);
    error TapeBehind(address feed);

    /// @dev The implementation: its pool (and the pool's USDG and registry) are code, shared by every proxy of it. Its
    ///      own storage is never used (initializers disabled, owned by nobody's key), so only a proxy is a vault. The
    ///      owner lives in Ownable's plain slots, set by `initialize` in the proxy's storage.
    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(CreditPoolV2 pool_) Ownable(address(0xdead)) {
        pool = pool_;
        usdg = pool_.usdg();
        registry = pool_.registry();
        holds = new StockVaultHolds();
        _disableInitializers();
    }

    /// @notice The proxy's one-time setup (StockVaultProxy's constructor calls it): the owner, where seized tokens and
    ///         fees go (the owner when zero), the terms, and the defaults of the price rules and idle windows.
    function initialize(address owner_, address seizeTo_, address feeSink_, Params calldata p) external initializer {
        if (owner_ == address(0)) revert InvalidParams();
        _transferOwnership(owner_);
        seizeTo = seizeTo_ == address(0) ? owner_ : seizeTo_;
        feeSink = feeSink_ == address(0) ? owner_ : feeSink_;
        _setParams(p);
        epochStart = uint64(block.timestamp);
        sessionMaxAge = 26 hours;
        idleAfter = 30 days;
        idleUndrawnAfter = 7 days;
        maxJumpBps = 2500;
        jumpWindow = 14 days;
        multiplierCooldown = 1 days;
        if (!usdg.approve(address(pool), type(uint256).max)) revert InvalidParams(); // USDG returns true
    }


    /// @dev One lock for the entry points and the hooks. A hook that arrives while the vault holds it is a callback
    ///      of the vault's own pool call (close freezing a line); it is skipped and the caller reconciles right after.
    modifier nonReentrant() {
        _enter();
        _;
        LOCK.asBoolean().tstore(false);
    }

    function _enter() internal {
        if (LOCK.asBoolean().tload()) revert Reentrancy();
        LOCK.asBoolean().tstore(true);
    }

    // ------------------------------------------------------------------
    // Identity and stake (as SeatVaultV3)
    // ------------------------------------------------------------------

    /// @notice Bind the vault to a fresh ERC-8004 identity it owns: register one, transfer it here, adopt. Once.
    function adopt(uint256 id) external onlyOwner {
        if (agentId != 0) revert AlreadyAdopted();
        if (registry.ownerOf(id) != address(this)) revert NotOurs(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.enrolledAt != 0 || a.isRoot) revert NotOurs(id);
        agentId = id;
        emit Adopted(id);
    }

    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    /// @notice Put USDG behind the vault's root as pool shares. The first call enrolls the root and makes this vault
    ///         its hook. The stake is what every line stands on, and all a default can cost the pool.
    function fund(uint256 amount) external nonReentrant {
        uint256 root = agentId;
        if (root == 0) revert NotAdopted();
        if (amount == 0) revert ZeroAmount();
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        if (pool.getAgent(root).isRoot) {
            pool.addStake(root, amount);
        } else {
            pool.enrollRoot(root, amount);
            pool.setHook(root, address(this));
        }
        emit Funded(msg.sender, amount);
    }

    /// @notice Take out stake that backs nothing, for the funder. The pool refuses anything vouched to an open line.
    function retire(uint256 shares, address to) external onlyOwner nonReentrant returns (uint256 assets_) {
        assets_ = pool.unlock(agentId, shares, to);
        uint256 room = _feeRoom(openLines);
        uint256 free = pool.freeBacking(agentId);
        if (free < room) revert NoFeeRoom(room, free); // the open lines' fee room stays
        emit Retired(shares, assets_, to);
    }

    // ------------------------------------------------------------------
    // Positions
    // ------------------------------------------------------------------

    /// @notice Deposit `amount` of an accepted stock `token` behind agent `id` and open its line: `ltvOf(id, token)`
    ///         of the deposit's value at the current price, at most `maxLine`, within the token's cap on open lines.
    ///         Only the agent's owner or pool delegate may call it, with the owner's signed pool consent `c` naming
    ///         this vault's root. An agent sponsored elsewhere with no loan open moves here (the pool's handoff). An
    ///         agent whose written-off position still owes its depositor tokens cannot open another (`reclaim` first):
    ///         the new record would replace the one those tokens are owed on.
    function open(uint256 id, address token, uint256 amount, CreditPoolV2.Consent calldata c, bytes calldata sig)
        external
        nonReentrant
        returns (uint256 line)
    {
        if (paused) revert VaultPaused();
        uint256 root = agentId;
        if (root == 0) revert NotAdopted();
        if (amount == 0) revert ZeroAmount();
        if (!pool.isController(id, msg.sender)) revert NotController(id, msg.sender);
        Status prior = positions[id].status;
        if (prior == Status.Open) revert PositionOpen(id);
        if (prior == Status.WrittenOff) revert TokensOwed(id);
        Asset storage asset = assets[token];
        if (!asset.enabled) revert AssetNotAccepted(token);
        address holder = registry.ownerOf(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (id == root || a.isRoot || a.defaulted || pool.ownerDefaults(holder) != 0) revert NotEligible(id);

        (bool ok, uint256 value) = _valueOf(token, amount);
        if (!ok) revert PriceUnavailable(token);
        uint8 hold = _lendStatus(token);
        if (hold != 0) revert LendingHeld(token, hold);
        line = value * ltvOf(id, token) / 10_000;
        if (line > params.maxLine) line = params.maxLine;
        uint256 minLoan = pool.getParams().minLoan;
        if (line < minLoan) revert LineTooSmall(line, minLoan);
        uint256 tokenLines = openLinesOf[token];
        if (tokenLines + line > asset.lineCap) {
            revert TokenCapReached(token, line, asset.lineCap > tokenLines ? asset.lineCap - tokenLines : 0);
        }
        _spend(line);
        uint256 needed = line + _feeRoom(openLines + line);
        uint256 free = pool.freeBacking(root);
        if (free < needed) revert NoFeeRoom(needed, free);
        openLines += line;
        openLinesOf[token] = tokenLines + line;

        _pull(token, msg.sender, amount);
        held[token] += amount;
        positions[id] = Position({
            depositor: msg.sender,
            owner: holder,
            token: token,
            openedAt: uint64(block.timestamp),
            closing: false,
            status: Status.Open,
            line: uint128(line),
            amount: amount
        });
        delete released[id]; // an earlier position's: this one starts with its whole line vouched, and no debt
        delete debt[id];
        delete recon[id];
        pool.vouchWithConsent(root, id, line, 0, c, sig);
        emit Opened(id, msg.sender, token, amount, value, line);
    }

    /// @notice Add more of the position's token. It raises the borrow limit (never the line vouched at opening).
    ///         The depositor only: every token of a position goes back to its depositor, so anyone else's would be
    ///         given away.
    function addCollateral(uint256 id, uint256 amount) external nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        if (amount == 0) revert ZeroAmount();
        if (msg.sender != p.depositor) revert NotDepositor(id, msg.sender);
        _pull(p.token, msg.sender, amount);
        held[p.token] += amount;
        p.amount += amount;
        emit CollateralAdded(id, msg.sender, amount);
    }

    /// @notice Close a position: the line freezes in the pool now; with no loan open every token goes back to the
    ///         depositor in this call, otherwise in the transaction that repays the last loan (a default seizes).
    ///         Either way the line goes back to this epoch's budget, unless the owner evicts the position too
    ///         (`freezePosition`, before or after) or it is seized.
    ///         The depositor or the agent's controller may call it; anyone may once the agent has changed hands.
    function close(uint256 id) external nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        if (msg.sender != p.depositor && !pool.isController(id, msg.sender) && registry.ownerOf(id) == p.owner) {
            revert NotDepositorOrController(id, msg.sender);
        }
        _close(id, p, true);
    }

    /// @notice The owner's lever: close a position exactly as its depositor could. It never seizes. The line stays
    ///         counted in this epoch's budget, even if the depositor closes it too (an evicted position cannot reopen
    ///         at once).
    function freezePosition(uint256 id) external onlyOwner nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        emit PositionFrozen(id, msg.sender);
        _close(id, p, false);
    }

    /// @notice Close a position that has had no loan open for `idleAfter` (since it opened, its last loan or its last
    ///         repayment), or for `idleUndrawnAfter` if its line was never drawn, every token back to its depositor.
    ///         Anyone: a line nobody uses must not keep the vault's stake. The line stays counted in this epoch's budget.
    function expire(uint256 id) external nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.activeLoans != 0) revert NotIdle(id);
        uint256 last = p.openedAt;
        uint256 window = idleAfter;
        if (a.lastBorrowAt < p.openedAt) {
            if (idleUndrawnAfter < window) window = idleUndrawnAfter; // never drawn on this position
        } else {
            last = a.lastBorrowAt > a.lastRepayAt ? a.lastBorrowAt : a.lastRepayAt;
        }
        if (block.timestamp < last + window) revert NotIdle(id);
        emit Expired(id);
        _close(id, p, false);
    }

    /// @notice The owner's last resort for a position whose tokens cannot be sent back (the issuer paused the token for
    ///         good, blocked this vault or the depositor, or the token stopped answering), with no loan open: its line
    ///         ends and leaves `openLines`, so the stake it held is free again. The tokens stay owed to the depositor
    ///         (still counted in `held`, out of `rescue`'s reach) and `reclaim` sends them once they move. A position
    ///         whose tokens can be sent is simply closed, as `freezePosition` would. Never seizes, no epoch refund.
    function writeOff(uint256 id) external onlyOwner nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.defaulted) revert AgentDefaulted(id); // settle() seizes it
        if (a.activeLoans != 0) revert LoanOpen(id);
        if (a.sponsor == agentId) pool.freeze(id, true); // no loan open: the line ends here (our onRelease is skipped)
        openLines -= p.line;
        openLinesOf[p.token] -= p.line;
        p.status = Status.WrittenOff;
        p.closing = false; // on a written-off position, `closing` marks a default's rest
        if (!_send(id, p)) emit WrittenOff(id, p.token, p.amount);
    }

    /// @notice Send a written-off position's tokens to its depositor, once the token moves again: the tokens a writeOff
    ///         left owed (the position closes), or a default's rest that could not be sent (it reads Seized again).
    ///         Anyone.
    function reclaim(uint256 id) external nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.WrittenOff) revert NoPosition(id);
        if (!_send(id, p)) revert NotSent(id);
    }

    function _close(uint256 id, Position storage p, bool refund) internal {
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.defaulted) revert AgentDefaulted(id); // settle() seizes it
        bool first = !p.closing;
        // freezePosition's "no refund" wins, whichever call ends the position: a close after a failed last onRelease
        // ends it here, and must keep the line counted as settle() would (GHSA-jgwm-4r5q-r2mf)
        refund = refund && (first || closeRefund[id]);
        if (a.sponsor == agentId) {
            pool.freeze(id, true); // our own onRelease callback is skipped: this call reconciles below
            if (first) {
                p.closing = true;
                emit CloseRequested(id, msg.sender);
            }
            if (a.activeLoans != 0) {
                closeRefund[id] = refund;
                released[id] += a.delegatedIn - a.principalOut; // the undrawn line the freeze gave back (`a`: before)
                return; // the last repayment closes it (onRelease), or settle()
            }
        }
        _end(id, p, refund);
    }

    /// @notice Reconcile a position with the pool by hand, for when a hook call failed or could not prove the debt.
    ///         Anyone; the second argument is not used (it was the proof of a default: the pool's loans now give it).
    ///         - The agent did not default: refused while the vault still backs it (StillBacked); otherwise every token
    ///           goes back, with the refund onRelease would have given (the line back in this epoch's budget unless
    ///           the owner evicted the position): who calls settle first changes nothing.
    ///         - The agent defaulted: refused while the vault still backs it (LoanOpen: a loan is still open, the debt
    ///           is not final). Otherwise its debt is summed from the pool's own loan records, never from the hooks:
    ///           principal + fee of every loan of the agent this vault backed since the position opened that
    ///           defaulted. The walk reads the pool's loans issued from the position's opening to the agent's last
    ///           borrow (both found by binary search; a defaulted agent never borrows again), at most SETTLE_PAGE per
    ///           call (`reconcile` takes its own page), and keeps its place and partial sum between calls: the position
    ///           ends only once the walk has read them all (seized for the debt, a default: see the contract's notice;
    ///           none, a default under another sponsor: every token back, no refund).
    function settle(uint256 id, uint256) external nonReentrant {
        _settle(id);
    }

    /// @notice `settle`, reading at most `maxLoans` (the second argument) of the pool's loans in this call. Anyone.
    function reconcile(uint256 id, uint256 /* maxLoans */ ) external nonReentrant {
        _settle(id);
    }

    /// @dev The page size is read here from the call (reconcile's second argument, else SETTLE_PAGE), not passed in: a
    ///      constant argument would make the compiler build a second copy of this function and _seize under it.
    function _settle(uint256 id) internal {
        uint256 max = msg.sig == this.reconcile.selector ? uint256(bytes32(msg.data[36:68])) : SETTLE_PAGE;
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.sponsor == agentId) {
            if (a.defaulted) revert LoanOpen(id);
            revert StillBacked(id);
        }
        if (!a.defaulted) return _end(id, p, !p.closing || closeRefund[id]);
        Recon memory r = recon[id];
        (uint256 next, uint256 end, uint256 owed, bool active) =
            holds.walk(pool, id, agentId, p.openedAt, a.lastBorrowAt, r.next, r.end, max);
        if (active) revert LoanOpen(id);
        owed += r.owed;
        if (next < end) {
            recon[id] = Recon(uint64(next), uint64(end), uint128(owed)); // more to read: the next call goes on
            return;
        }
        if (owed == 0) _end(id, p, false);
        else _seize(id, p, owed);
    }

    // ------------------------------------------------------------------
    // Backer hooks (called by the pool, which holds its own lock throughout)
    // ------------------------------------------------------------------

    /// @notice A new loan is allowed only on an open position that is not closing, while the vault is not paused, for
    ///         the owner who opened it, at a fresh and unpaused price with no lending hold, and while the agent's drawn
    ///         principal plus this loan stays within `ltvOf(id, token)` of the collateral's value now: the value of what
    ///         the position would be paid (_payout), which an issuer burn cuts.
    function canBorrow(uint256 rootId, uint256 id, uint256 amount, uint64, uint256, address, address owner, address)
        external
        view
        returns (bool)
    {
        Position storage p = positions[id];
        if (rootId != agentId || rootId == 0 || p.status != Status.Open || p.closing || paused) return false;
        if (owner != p.owner) return false;
        (bool ok, uint256 value) = _valueOf(p.token, _payout(p.token, p.amount));
        if (!ok || _lendStatus(p.token) != 0) return false;
        return pool.getAgent(id).principalOut + amount <= value * ltvOf(id, p.token) / 10_000;
    }

    function onBorrow(uint256, uint256, uint256) external {}

    /// @notice A loan under this vault defaulted: its principal and the fee the pool stored for it are added to the
    ///         position's debt. Nothing is seized here: the debt is final once the agent has no loan left, and the pool
    ///         then releases the dead agent's residual line (onRelease: in this same transaction when this loan was its
    ///         last), which seizes the position for it (a default: see the contract's notice). Until then the whole
    ///         deposit stays, and close() refuses a defaulted agent. (Seizing here too would leave the busiest live
    ///         feed's checks too little of this hook's gas: the pool gives each hook 300,000; onRelease has its own.)
    function onDefault(uint256 rootId, uint256 id, uint256 loanId, uint256, bool) external {
        if (!_hookCall(rootId)) return;
        Position storage p = positions[id];
        if (p.status != Status.Open) return;
        CreditPoolV2.Loan memory l = pool.getLoan(loanId); // the pool calls the loan's sponsor: this vault's root
        if (l.issuedAt < p.openedAt) return; // not this position's (none can be: a line ends with its last loan)
        Debt storage d = debt[id];
        d.owed += uint128(l.principal + l.fee);
        d.principal += uint128(l.principal);
    }

    /// @notice Part of a line came back. If the sponsorship ended (leave, handoff, a frozen line's last loan), the
    ///         position closes, every token back, unless the agent is defaulted: when the pool releases its residual
    ///         line (its last loan closed, repaid or defaulted) the position is seized for the debt onDefault summed,
    ///         once that debt accounts for the whole line (_endDefault); otherwise settle. Closed, its line goes back
    ///         to this epoch's budget, unless the owner evicted the position (`freezePosition`). A part that comes back
    ///         while the line stays (a frozen line's repayment) is recorded. A default's rest that could not be sent
    ///         is sent now (as `reclaim` would).
    function onRelease(uint256 rootId, uint256 id, uint256 amount, uint8 reason) external {
        if (!_hookCall(rootId)) return;
        Position storage p = positions[id];
        if (p.status == Status.WrittenOff && p.closing) {
            _enter(); // a default's rest onDefault could not send: try again (the dead agent's residual, its last loan)
            _send(id, p);
            LOCK.asBoolean().tstore(false);
            return;
        }
        if (p.status != Status.Open) return;
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.sponsor == rootId) {
            released[id] += amount; // part of the line only; the position stays open
            return;
        }
        _enter();
        if (!a.defaulted) _end(id, p, !p.closing || closeRefund[id]);
        else if (reason == uint8(CreditPoolV2.Release.DefaultResidual)) _endDefault(id, p, debt[id], amount);
        LOCK.asBoolean().tstore(false);
    }

    function _hookCall(uint256 rootId) internal view returns (bool) {
        return msg.sender == address(pool) && rootId == agentId && rootId != 0 && !LOCK.asBoolean().tload();
    }

    // ------------------------------------------------------------------
    // Fees
    // ------------------------------------------------------------------

    /// @notice Send the root's sponsor fees (the vault has no stakers to share them with) to the fee sink. Anyone.
    ///         Only the fees: any other USDG the vault holds (cash paid to it as the tokens' holder, for its
    ///         depositors) leaves only through the owner's logged `rescueUsdg`.
    function skim() external nonReentrant returns (uint256 amount) {
        uint256 root = agentId;
        if (root != 0 && pool.sponsorFees(root) > 0) amount = pool.claimSponsorFees(root, feeSink);
        emit Skimmed(amount, feeSink);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function getPosition(uint256 id) external view returns (Position memory) {
        return positions[id];
    }

    function assetList() external view returns (address[] memory) {
        return _assetList;
    }

    /// @notice USDG value of `amount` of `token` at its current price (6 decimals); `ok` false (and `value` 0) when the
    ///         price cannot be used for new credit (unknown asset, no feed answer, stale, a feed or a token that answers
    ///         in other decimals than setAsset read, oracle paused, or a lending hold: lendStatus says which).
    function valueOf(address token, uint256 amount) external view returns (bool ok, uint256 value) {
        (ok, value) = _valueOf(token, amount);
        if (ok && _lendStatus(token) != 0) return (false, 0);
    }

    /// @notice Why new lines and loans against `token` wait now: 0 none, HOLD_PRICE_MOVED (the price moved more than
    ///         `maxJumpBps` within `jumpWindow`, or its history cannot be read or is not recorded yet on the feed's price
    ///         tape: `holds().record(feed, n)`; only the last of these makes a default's seizure wait, see `settle`),
    ///         HOLD_MULTIPLIER (the token's multiplier
    ///         changes or changed within `multiplierCooldown`), HOLD_TOKEN_PAUSED, HOLD_TOKEN_BLOCKED (this vault or
    ///         `seizeTo` is on the token's block list).
    function lendStatus(address token) external view returns (uint8) {
        return _lendStatus(token);
    }

    /// @notice What agent `id` could still draw on its position now (0 when a loan would be refused).
    function borrowRoom(uint256 id) external view returns (uint256) {
        Position storage p = positions[id];
        if (p.status != Status.Open || p.closing || paused) return 0;
        (bool ok, uint256 value) = _valueOf(p.token, _payout(p.token, p.amount));
        if (!ok || _lendStatus(p.token) != 0) return 0;
        uint256 limit = value * ltvOf(id, p.token) / 10_000;
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        uint256 cap = a.delegatedIn > a.principalOut ? a.delegatedIn - a.principalOut : 0;
        uint256 byValue = limit > a.principalOut ? limit - a.principalOut : 0;
        return byValue < cap ? byValue : cap;
    }

    /// @notice The loan-to-value agent `id` gets against `token` now: the stock's own (`Asset.ltvBps`), plus the
    ///         agent's record bonus scaled by how the stock's own compares with `params.ltvBps` (a 25% stock gets half
    ///         the bonus of a 50% one, never more than the full bonus), never more than MAX_LTV_BPS in all. For an agent
    ///         with no record (or id 0), the stock's own; 0 for a token never accepted.
    function ltvOf(uint256 id, address token) public view returns (uint256 bps) {
        bps = assets[token].ltvBps;
        uint256 dflt = params.ltvBps;
        if (bps != 0 && id != 0) {
            uint256 bonus = recordBonusBps(id);
            if (bonus != 0) bps += bonus * (bps < dflt ? bps : dflt) / dflt;
        }
        if (bps > MAX_LTV_BPS) bps = MAX_LTV_BPS;
    }

    /// @notice What agent `id`'s record adds to its loan-to-value: `bonusBpsPerStep` for every `bonusFeeStep` of fees
    ///         it paid on repaid loans the trusted roots backed (the pool's `feesFrom`), at most `maxBonusBps`. This
    ///         vault's own root never counts, whatever the list says.
    function recordBonusBps(uint256 id) public view returns (uint256) {
        return holds.recordBonus(pool, _trustedRoots, agentId, id, bonusFeeStep, bonusBpsPerStep, maxBonusBps);
    }

    function trustedRoots() external view returns (uint256[] memory) {
        return _trustedRoots;
    }

    /// @notice The buffer a default on `token` keeps on top of what is owed, in basis points: the token's own if the
    ///         owner set one, otherwise the vault's (seizeBufferBps).
    function seizeBufferOf(address token) public view returns (uint256 bps) {
        bps = seizeBuffer[token];
        if (bps == 0) bps = seizeBufferBps();
    }

    /// @notice The vault's own buffer, in basis points: 20% until the owner sets one (setSeizeBuffer, `token` 0).
    function seizeBufferBps() public view returns (uint256 bps) {
        bps = seizeBuffer[address(0)];
        if (bps == 0) bps = DEFAULT_SEIZE_BUFFER_BPS;
    }

    function epochRoom() public view returns (uint256) {
        uint256 used = block.timestamp >= epochStart + params.epochLength ? 0 : linedThisEpoch;
        return params.epochCap > used ? params.epochCap - used : 0;
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    /// @notice Accept (or stop accepting) a stock token, priced by `feed` and refused when its price is older than
    ///         `maxAge`, with its own risk: `ltvBps`, the share of its value a line and a loan get (MIN_LTV_BPS to
    ///         MAX_LTV_BPS), and `lineCap`, the USDG of open lines it may back all together (0: no new line). One call,
    ///         so a token is never accepted without its risk set. Disabling stops new positions only; open ones keep
    ///         being priced by the feed set here and lent against at the LTV set here (lowering it shrinks what they
    ///         can still draw, as a falling price would). The feed's and the token's decimals are read here: a feed that
    ///         later answers in others (its proxy moved to an aggregator of another precision), or a token that does
    ///         (its issuer upgraded it to another precision), prices no new credit until this is called again with the
    ///         same feed, which reads them again.
    function setAsset(address token, address feed, uint64 maxAge, bool enabled, uint16 ltvBps, uint128 lineCap)
        external
        onlyOwner
    {
        if (token == address(0) || feed == address(0) || token == address(usdg)) revert InvalidParams();
        if (maxAge == 0 || maxAge > MAX_PRICE_AGE) revert InvalidParams();
        if (ltvBps < MIN_LTV_BPS || ltvBps > MAX_LTV_BPS) revert InvalidParams();
        uint8 fdec = IPriceFeed(feed).decimals();
        uint8 tdec = IERC20Metadata(token).decimals();
        if (fdec == 0 || fdec > 18 || tdec > 36) revert InvalidParams();
        if (assets[token].feed == address(0)) {
            if (_assetList.length >= MAX_ASSETS) revert InvalidParams();
            _assetList.push(token);
        } else if (held[token] != 0 && assets[token].feed != feed) {
            revert Protected(token); // a new feed for collateral already held would reprice positions under their feet
        }
        assets[token] = Asset({
            feed: feed,
            maxAge: maxAge,
            tokenDecimals: tdec,
            feedDecimals: fdec,
            enabled: enabled,
            ltvBps: ltvBps,
            lineCap: lineCap
        });
        emit AssetSet(token, feed, maxAge, enabled, ltvBps, lineCap);
    }

    function setParams(Params calldata p) external onlyOwner {
        _setParams(p);
    }

    /// @notice The record bonus: the roots whose repaid loans count (at most MAX_TRUSTED_ROOTS pool roots, never this
    ///         vault's own; only roots an agent's owner cannot back itself), and how fees paid under them turn into
    ///         loan-to-value (in the pool's sponsor-fee units: retune it with the pool's fee params). `maxBonus` 0
    ///         turns it off.
    function setRecordBonus(uint256[] calldata roots, uint256 feeStep, uint16 bpsPerStep, uint16 maxBonus)
        external
        onlyOwner
    {
        if (roots.length > MAX_TRUSTED_ROOTS || maxBonus > MAX_BONUS_BPS) revert InvalidParams();
        if (maxBonus != 0 && (feeStep < MIN_BONUS_FEE_STEP || bpsPerStep == 0 || bpsPerStep > maxBonus)) {
            revert InvalidParams();
        }
        for (uint256 i; i < roots.length; ++i) {
            if (roots[i] == 0 || roots[i] == agentId || !pool.getAgent(roots[i]).isRoot) revert InvalidParams();
            for (uint256 j; j < i; ++j) {
                if (roots[j] == roots[i]) revert InvalidParams();
            }
        }
        _trustedRoots = roots;
        bonusFeeStep = feeStep;
        bonusBpsPerStep = bpsPerStep;
        maxBonusBps = maxBonus;
        emit RecordBonusUpdated(roots, feeStep, bpsPerStep, maxBonus);
    }

    /// @notice How old a price may be while the market trades (the week's last price is judged by the weekend rule).
    function setSessionMaxAge(uint64 age) external onlyOwner {
        if (age < 1 hours || age > MAX_PRICE_AGE) revert InvalidParams();
        sessionMaxAge = age;
        emit SessionMaxAgeUpdated(age);
    }

    function setIdleAfter(uint64 after_) external onlyOwner {
        if (after_ < 1 days || after_ > MAX_EPOCH) revert InvalidParams();
        idleAfter = after_;
        emit IdleAfterUpdated(after_);
    }

    /// @notice How long a line never drawn keeps the stake before anyone may expire it (capped by `idleAfter`).
    function setIdleUndrawnAfter(uint64 after_) external onlyOwner {
        if (after_ < 1 days || after_ > MAX_EPOCH) revert InvalidParams();
        idleUndrawnAfter = after_;
        emit IdleUndrawnAfterUpdated(after_);
    }

    /// @notice The lending holds' bounds: the price move that holds new credit (5% to 50%), the window it is measured
    ///         over (0: against the previous round only) and the wait after a multiplier change, both at most 14 days.
    function setPriceGuard(uint16 maxJumpBps_, uint64 jumpWindow_, uint64 multiplierCooldown_) external onlyOwner {
        if (maxJumpBps_ < MIN_JUMP_BPS || maxJumpBps_ > MAX_JUMP_BPS) revert InvalidParams();
        if (jumpWindow_ > MAX_GUARD_WINDOW || multiplierCooldown_ > MAX_GUARD_WINDOW) revert InvalidParams();
        maxJumpBps = maxJumpBps_;
        jumpWindow = jumpWindow_;
        multiplierCooldown = multiplierCooldown_;
        emit PriceGuardUpdated(maxJumpBps_, jumpWindow_, multiplierCooldown_);
    }

    /// @notice The buffer a default keeps on top of what is owed: the vault's (`token` 0), or one token's own (a thin
    ///         name: a larger one; 0 hands it back to the vault's), MIN_SEIZE_BUFFER_BPS to MAX_SEIZE_BUFFER_BPS. Only
    ///         the defaults after it use it.
    function setSeizeBuffer(address token, uint16 bps) external onlyOwner {
        if (bps > MAX_SEIZE_BUFFER_BPS || (bps < MIN_SEIZE_BUFFER_BPS && (bps != 0 || token == address(0)))) {
            revert InvalidParams();
        }
        seizeBuffer[token] = bps;
        emit SeizeBufferSet(token, bps);
    }

    function pause(bool paused_) external onlyOwner {
        paused = paused_;
        emit Paused(paused_);
    }

    function setSeizeTo(address to) external onlyOwner {
        if (to == address(0)) revert InvalidParams();
        seizeTo = to;
        emit SeizeToUpdated(to);
    }

    function setFeeSink(address sink) external onlyOwner {
        if (sink == address(0)) revert InvalidParams();
        feeSink = sink;
        emit FeeSinkUpdated(sink);
    }

    /// @notice Recover a token sent here by mistake. Collateral of open positions is out of reach (only the part of a
    ///         token's balance above `held` can leave this way); USDG leaves only through `rescueUsdg`.
    function rescue(address token_, address to) external onlyOwner nonReentrant {
        if (token_ == address(usdg)) revert Protected(token_);
        uint256 bal = IERC20(token_).balanceOf(address(this));
        uint256 amount = bal > held[token_] ? bal - held[token_] : 0;
        if (amount == 0) revert Protected(token_);
        IERC20(token_).safeTransfer(to, amount);
        emit Rescued(token_, to, amount);
    }

    /// @notice The only way out for USDG the vault holds: sponsor fees go straight from the pool to the fee sink
    ///         (skim), so any USDG here was paid to the vault for someone else (a cash distribution on the tokens it
    ///         holds for its depositors, a stray transfer). The owner sends it on, logged.
    function rescueUsdg(address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0) || amount == 0) revert InvalidParams();
        usdg.safeTransfer(to, amount);
        emit UsdgRescued(to, amount);
    }

    /// @notice Disabled: `retire`, `writeOff` and every other lever need an owner; renouncing would lock the funder's
    ///         stake behind the open lines for good.
    function renounceOwnership() public pure override {
        revert Renounce();
    }

    // ------------------------------------------------------------------
    // Internals
    // ------------------------------------------------------------------

    /// @dev Value in USDG (6 decimals) at the feed's price; `ok` false rather than a revert, so the borrow hook can
    ///      refuse cleanly. A price is used only if positive, not in the future, younger than the asset's `maxAge`,
    ///      in the decimals `setAsset` read from the feed, for a token that still answers the decimals `setAsset` read
    ///      from it, and while the token does not flag its oracle as paused (the flag is advisory: a token without it
    ///      passes).
    function _valueOf(address token, uint256 amount) internal view returns (bool ok, uint256 value) {
        uint256 price;
        (ok, price) = _priceOf(token);
        if (!ok) return (false, 0);
        Asset storage a = assets[token];
        uint256 scale = uint256(a.tokenDecimals) + a.feedDecimals;
        value = scale >= 6 ? Math.mulDiv(amount, price, 10 ** (scale - 6)) : amount * price * 10 ** (6 - scale);
    }

    /// @dev The feed's answer for `token` (in the feed's decimals) when `_valueOf` may use it (see there), as the
    ///      vault's StockVaultHolds reads it with the asset's settings; (false, 0) otherwise.
    function _priceOf(address token) internal view returns (bool ok, uint256 price) {
        Asset storage a = assets[token];
        if (a.feed == address(0)) return (false, 0);
        return holds.priceOf(token, a.feed, a.maxAge, a.feedDecimals, a.tokenDecimals, sessionMaxAge);
    }

    /// @dev 0 when new credit against `token` may go ahead; otherwise the first hold that applies (see lendStatus),
    ///      as the vault's StockVaultHolds reads it with the vault's settings (a tape behind: HOLD_PRICE_MOVED).
    function _lendStatus(address token) internal view returns (uint8 h) {
        h = _holdOf(token);
        if (h == HOLD_TAPE_BEHIND) h = HOLD_PRICE_MOVED;
    }

    /// @dev `_lendStatus` with HOLD_TAPE_BEHIND as such, for `_seize`.
    function _holdOf(address token) internal view returns (uint8) {
        return holds.lendStatus(
            address(this), token, assets[token].feed, seizeTo, multiplierCooldown, maxJumpBps, jumpWindow
        );
    }

    /// @dev A static call that answered at least one word: (true, that word); anything else: (false, 0).
    function _read(address target, bytes memory data) internal view returns (bool ok, uint256 word) {
        if (target.code.length == 0) return (false, 0);
        assembly ("memory-safe") {
            ok := staticcall(gas(), target, add(data, 0x20), mload(data), 0, 0x20)
            ok := and(ok, gt(returndatasize(), 31))
            if ok { word := mload(0) }
        }
    }

    /// @dev The largest fee `lines` of loans can lock: the pool's base fee over its longest term (the vault charges
    ///      no premium), rounded up.
    function _feeRoom(uint256 lines) internal view returns (uint256) {
        CreditPoolV2.Params memory pp = pool.getParams();
        return Math.mulDiv(lines, pp.feeBps * pp.maxTerm, 10_000 * 30 days, Math.Rounding.Ceil);
    }

    /// @dev Refused while the vault holds less of `token` than it owes (an issuer burn not yet paid out): the new tokens
    ///      would be owed back at the same short share, paying the positions the burn hit.
    function _pull(address token, address from, uint256 amount) internal {
        uint256 before = IERC20(token).balanceOf(address(this));
        if (before < held[token]) revert Shortfall(token);
        IERC20(token).safeTransferFrom(from, address(this), amount);
        uint256 got = IERC20(token).balanceOf(address(this)) - before;
        if (got != amount) revert BadTransfer(amount, got); // no fee-on-transfer surprises: collateral is exact
    }

    /// @dev Close an open position: every token back to the depositor (the position's share of what the vault still
    ///      holds of it, _payout); with `refund`, the line back in this epoch's budget. A default seizes (_seize).
    function _end(uint256 id, Position storage p, bool refund) internal {
        (address token, uint256 out) = _unbook(p, Status.Closed);
        if (refund && p.openedAt >= epochStart) {
            uint256 line = p.line;
            linedThisEpoch -= line < linedThisEpoch ? line : linedThisEpoch;
        }
        IERC20(token).safeTransfer(p.depositor, out);
        emit Closed(id, p.depositor, out);
    }

    /// @dev End a defaulted position whose agent has no loan left (onRelease), from `d`, the debt onDefault summed.
    ///      Seized for `d.owed` only if the line adds up: the defaulted principal it sums, `backed` (the residual line
    ///      the pool releases now) and the undrawn line it gave back (`released`) make up the whole line. A default no
    ///      hook summed (a failed onDefault, a skipped one) or a release none recorded breaks it: the position stays
    ///      open, the whole deposit with it, for settle, which sums the pool's loans. A position the old implementation
    ///      left closing (its freeze never recorded) breaks it too: settle, exactly.
    function _endDefault(uint256 id, Position storage p, Debt memory d, uint256 backed) internal {
        if (d.principal == 0 || uint256(d.principal) + backed + released[id] != p.line) return;
        _seize(id, p, d.owed);
    }

    /// @dev Seize an open position for a default (see the contract's notice) that owes `owed` (USDG, exact): the tokens
    ///      worth `owed` plus the buffer at the price, rounded up (at most one base unit of the token over the exact
    ///      quotient: the funder's favour), when the price lends now; every token otherwise. While the feed's price
    ///      tape is behind (more of the window than the hold reads live), it reverts TapeBehind(feed) instead: that
    ///      says nothing of the price, and seizing everything on it was anyone's to time (GHSA-q29p-rp35-p8v2). The
    ///      default's hook then fails and the position waits, the whole deposit with it, for `settle` once anyone has
    ///      recorded the tape. A rest the token refuses to send (or that `RETURN_GAS_RESERVE` leaves no gas for) stays
    ///      owed as a written-off position's tokens: in `held`, at the position's share, for `reclaim`.
    function _seize(uint256 id, Position storage p, uint256 owed) internal {
        uint256 amount = p.amount;
        (address token, uint256 out) = _unbook(p, Status.Seized);
        uint256 buffer = seizeBufferOf(token);
        (bool ok, uint256 price) = _priceOf(token);
        uint256 take = out; // everything, unless the price lends now and leaves a rest
        Asset storage s = assets[token];
        uint256 scale = uint256(s.tokenDecimals) + s.feedDecimals; // under 6 (no token today): everything
        if (ok && scale >= 6 && (owed | price) <= type(uint128).max) {
            // ceil(owed × (1 + buffer) / price), in token units: owed and the buffer in USDG (6 decimals)
            uint256 t = Math.mulDiv(owed * (10_000 + buffer), 10 ** (scale - 6), 10_000 * price, Math.Rounding.Ceil);
            if (t < out) {
                uint8 h = _holdOf(token);
                if (h == HOLD_TAPE_BEHIND) revert TapeBehind(s.feed);
                if (h == 0) take = t;
            }
        }
        IERC20(token).safeTransfer(seizeTo, take);
        emit Seized(id, seizeTo, token, take);
        if (take == out) return;
        uint256 rest = out - take;
        address to = p.depositor;
        uint256 g = gasleft();
        bool sent = _transfer(token, to, rest, g > RETURN_GAS_RESERVE ? g - RETURN_GAS_RESERVE : 0);
        if (!sent) {
            uint256 n = out == amount ? rest : Math.mulDiv(amount, rest, out); // the rest in `held`'s units
            held[token] += n;
            p.amount = n;
            p.status = Status.WrittenOff;
            p.closing = true; // a default's rest: the pool's next onRelease, or anyone's reclaim, sends it
        }
        emit Returned(id, to, token, rest, owed, price, buffer, sent);
    }

    /// @dev Take an ending position off the books with its new `status`: its tokens out of `held`, its line out of the
    ///      open lines. Returns its token, and what it is paid now (_payout, read first).
    function _unbook(Position storage p, Status status) internal returns (address token, uint256 out) {
        p.status = status;
        token = p.token;
        out = _payout(token, p.amount);
        held[token] -= p.amount;
        openLines -= p.line;
        openLinesOf[token] -= p.line;
    }

    /// @dev What `amount` owed of `token` pays now: all of it, or, when the vault holds less than it owes (an issuer's
    ///      burn from the vault), the same share for every position of that token, so the last one out can still end.
    function _payout(address token, uint256 amount) internal view returns (uint256) {
        uint256 owed = held[token];
        uint256 bal = IERC20(token).balanceOf(address(this));
        return bal >= owed ? amount : Math.mulDiv(amount, bal, owed);
    }

    /// @dev Try to send a written-off position's tokens to its depositor (`writeOff`, `reclaim`); false, and nothing
    ///      changed, when the token does not move.
    function _send(uint256 id, Position storage p) internal returns (bool) {
        address token = p.token;
        (bool ok, uint256 bal) = _read(token, abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (!ok) return false;
        uint256 owed = held[token];
        uint256 out = bal >= owed ? p.amount : Math.mulDiv(p.amount, bal, owed);
        if (!_transfer(token, p.depositor, out, gasleft())) return false;
        held[token] = owed - p.amount;
        p.status = p.closing ? Status.Seized : Status.Closed; // a default's rest, sent: the position stays seized
        emit Closed(id, p.depositor, out);
        return true;
    }

    /// @dev `token.transfer(to, amount)` with at most `gas_`, as a call that never reverts the caller: true only if it
    ///      succeeded and answered nothing or true.
    function _transfer(address token, address to, uint256 amount, uint256 gas_) internal returns (bool ok) {
        bytes memory ret;
        (ok, ret) = token.call{gas: gas_}(abi.encodeCall(IERC20.transfer, (to, amount)));
        return ok && (ret.length == 0 || (ret.length >= 32 && uint256(bytes32(ret)) == 1));
    }

    function _spend(uint256 amount) internal {
        if (block.timestamp >= epochStart + params.epochLength) {
            epochStart = uint64(block.timestamp);
            linedThisEpoch = 0;
        }
        uint256 left = params.epochCap > linedThisEpoch ? params.epochCap - linedThisEpoch : 0;
        if (amount > left) revert EpochCapReached(amount, left);
        linedThisEpoch += amount;
    }

    function _setParams(Params memory p) internal {
        if (p.ltvBps == 0 || p.ltvBps > MAX_LTV_BPS || p.maxLine == 0 || p.epochCap == 0) revert InvalidParams();
        if (p.maxLine > type(uint128).max) revert InvalidParams(); // a line always fits Position.line

        if (p.epochLength == 0 || p.epochLength > MAX_EPOCH) revert InvalidParams();
        params = p;
        emit ParamsUpdated(p);
    }
}
