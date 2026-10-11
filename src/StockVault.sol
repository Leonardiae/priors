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
///           default                             the pool tells the vault (onDefault): the collateral is seized, sent
///                                               to `seizeTo`, and never returned to the depositor.
///           settle(agent, loanId)               the manual path for any of the above, if a hook call ever failed.
///           writeOff(agent) / reclaim(agent)    the owner ends the line of a position whose token cannot be sent
///                                               back; the tokens stay owed to the depositor until they move again.
///
///         Every new loan asks the vault (canBorrow): it is refused unless the price is fresh, the token's oracle is not
///         paused, no lending hold applies (lendStatus), the agent still belongs to the owner who opened the
///         position, and the agent's drawn principal plus the new loan stays within `ltvOf(agent, token)` of the
///         collateral's value now. A falling price therefore shrinks what can be drawn; loans already open are untouched.
///
///         Lending holds, for new lines and new loans only (repaying, closing and settling never wait on them): the
///         feed's answer moved more than `maxJumpBps` against a round of the last `jumpWindow` (a reverse split
///         the feed's multiplier has not caught up with yet shows as one); the token's multiplier changes, or changed
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
///         pool is backed; a default is paid from it, and the seized stock goes to `seizeTo` (the funder) to make up
///         for it. Lenders never carry the risk. The owner can pause, retune future terms and freeze a position (every
///         token back to its depositor), but can never take a depositor's tokens except through a default, short of
///         an upgrade.
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
    uint256 internal constant DECIMALS_READ_GAS = 50_000; // a token's or feed's decimals(): a beacon proxy's is ~15,000
    uint256 internal constant MAX_JUMP_BPS = 5000; // the loosest price-jump bound the owner can set (a 1:2 split is 10000)
    uint256 internal constant MIN_JUMP_BPS = 500;
    uint64 internal constant MAX_GUARD_WINDOW = 14 days;
    // rounds read back at most: 1, 2, 4 ... 4096 rounds before the latest. The busiest of the 35 live feeds published 650
    // rounds in 14 days (CRCL, read on 2026-09-28), so a 14-day window is reached with about 6x to spare.
    uint256 internal constant JUMP_SAMPLES = 13;
    // lendStatus reasons (0: no hold)
    uint8 public constant HOLD_PRICE_MOVED = 1;
    uint8 public constant HOLD_MULTIPLIER = 2;
    uint8 public constant HOLD_TOKEN_PAUSED = 3;
    uint8 public constant HOLD_TOKEN_BLOCKED = 4;
    bytes32 internal constant LOCK = keccak256("priors.stockvault.v1.lock");

    enum Status {
        None,
        Open,
        Closed,
        Seized,
        WrittenOff // the line ended by writeOff; the tokens are still owed to the depositor (reclaim)
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

    CreditPoolV2 public immutable pool;
    IERC20 public immutable usdg;
    IERC8004Identity public immutable registry;

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

    /// @dev The implementation: its pool (and the pool's USDG and registry) are code, shared by every proxy of it. Its
    ///      own storage is never used (initializers disabled, owned by nobody's key), so only a proxy is a vault. The
    ///      owner lives in Ownable's plain slots, set by `initialize` in the proxy's storage.
    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(CreditPoolV2 pool_) Ownable(address(0xdead)) {
        pool = pool_;
        usdg = pool_.usdg();
        registry = pool_.registry();
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
        if (!_send(id, p)) emit WrittenOff(id, p.token, p.amount);
    }

    /// @notice Send a written-off position's tokens to its depositor, once the token moves again. Anyone.
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
                return; // the last repayment closes it (onRelease), or settle()
            }
        }
        _end(id, p, false, refund);
    }

    /// @notice Reconcile a position with the pool by hand, for when a hook call failed. Anyone.
    ///         - The agent defaulted while the vault still backs it: the collateral is seized.
    ///         - The agent defaulted and the vault no longer backs it: `loanId` must be one of its defaulted loans.
    ///           Backed by this vault since the position opened: seized. Otherwise every token goes back.
    ///         - The agent did not default and the vault no longer backs it: every token goes back.
    ///         A position it closes gets the refund onRelease would have given it (the line back in this epoch's budget
    ///         unless the agent defaulted or the owner evicted the position): who calls settle first changes nothing.
    function settle(uint256 id, uint256 loanId) external nonReentrant {
        Position storage p = positions[id];
        if (p.status != Status.Open) revert NoPosition(id);
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        bool seize;
        if (a.sponsor == agentId) {
            if (!a.defaulted) revert StillBacked(id);
            seize = true;
        } else if (a.defaulted) {
            CreditPoolV2.Loan memory l = pool.getLoan(loanId);
            if (l.agentId != id || l.status != CreditPoolV2.LoanStatus.Defaulted || loanId == 0) {
                revert BadProof(id, loanId);
            }
            if (l.sponsorId == agentId) {
                if (l.issuedAt < p.openedAt) revert BadProof(id, loanId);
                seize = true;
            }
        }
        _end(id, p, seize, !seize && !a.defaulted && (!p.closing || closeRefund[id]));
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

    /// @notice A loan under this vault defaulted: the position's collateral is seized now, to `seizeTo`.
    function onDefault(uint256 rootId, uint256 id, uint256, uint256, bool) external {
        if (!_hookCall(rootId)) return;
        Position storage p = positions[id];
        if (p.status != Status.Open) return;
        _enter();
        _end(id, p, true, false);
        LOCK.asBoolean().tstore(false);
    }

    /// @notice Part of a line came back. If the sponsorship ended (leave, handoff, a frozen line's last loan), the
    ///         position closes, every token back, unless the agent is defaulted: then the collateral is seized. Closed,
    ///         its line goes back to this epoch's budget, unless the owner evicted the position (`freezePosition`).
    function onRelease(uint256 rootId, uint256 id, uint256, uint8) external {
        if (!_hookCall(rootId)) return;
        Position storage p = positions[id];
        if (p.status != Status.Open) return;
        CreditPoolV2.Agent memory a = pool.getAgent(id);
        if (a.sponsor == rootId) return; // part of the line only; the position stays open
        _enter();
        _end(id, p, a.defaulted, !a.defaulted && (!p.closing || closeRefund[id]));
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
    ///         `maxJumpBps` within `jumpWindow`, or its history cannot be read), HOLD_MULTIPLIER (the token's multiplier
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
        uint256 step = bonusFeeStep;
        uint256 per = bonusBpsPerStep;
        uint256 cap = maxBonusBps;
        if (step == 0 || per == 0 || cap == 0) return 0;
        uint256 own = agentId;
        uint256 paid;
        uint256 n = _trustedRoots.length;
        for (uint256 i; i < n; ++i) {
            uint256 root = _trustedRoots[i];
            if (root != own) paid += pool.feesFrom(root, id);
        }
        uint256 steps = paid / step;
        if (steps >= cap / per + 1) return cap;
        uint256 bonus = steps * per;
        return bonus < cap ? bonus : cap;
    }

    function trustedRoots() external view returns (uint256[] memory) {
        return _trustedRoots;
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
        Asset storage a = assets[token];
        if (a.feed == address(0)) return (false, 0);
        uint256 price;
        try IPriceFeed(a.feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp || !_fresh(updatedAt, a.maxAge)) {
                return (false, 0);
            }
            price = uint256(answer);
        } catch {
            return (false, 0);
        }
        // a Chainlink proxy answers in its current aggregator's decimals: one its owner moved to another precision
        // would be priced on the old scale (8 to 18 decimals: 10^10 times the value). Nothing is priced until the
        // owner's setAsset reads the feed again (GHSA-rwj3-gr68-p93p)
        (bool okF, uint8 fdec) = _decimalsOf(a.feed);
        if (!okF || fdec != a.feedDecimals) return (false, 0);
        // the token's own scale, the other half of it: a stock token is a beacon proxy, and an implementation its
        // issuer installs in another precision would be priced on the old one (18 to 24 decimals: 10^6 times the
        // value), with no hold to catch it. Nothing is priced until the owner's setAsset reads the token again
        // (GHSA-855q-24q2-qwph)
        (bool okT, uint8 tdec) = _decimalsOf(token);
        if (!okT || tdec != a.tokenDecimals) return (false, 0);
        try IStockToken(token).oraclePaused() returns (bool paused_) {
            if (paused_) return (false, 0);
        } catch {}
        uint256 scale = uint256(a.tokenDecimals) + a.feedDecimals;
        value = scale >= 6 ? Math.mulDiv(amount, price, 10 ** (scale - 6)) : amount * price * 10 ** (6 - scale);
        return (true, value);
    }

    /// @dev 0 when new credit against `token` may go ahead; otherwise the first hold that applies (see lendStatus).
    ///      Every read is a bounded static call: a token or registry without the function holds nothing back.
    function _lendStatus(address token) internal view returns (uint8) {
        if (_flag(token, abi.encodeCall(IStockToken.paused, ()))) return HOLD_TOKEN_PAUSED;
        address reg = token;
        (bool ok, uint256 w) = _read(token, abi.encodeCall(IStockToken.ACCESS_CONTROLLED_REGISTRY, ()));
        if (ok && address(uint160(w)) != address(0)) reg = address(uint160(w));
        if (reg != token && _flag(reg, abi.encodeCall(IAccessRegistry.paused, ()))) return HOLD_TOKEN_PAUSED;
        if (
            _flag(reg, abi.encodeCall(IAccessRegistry.isBlocked, (address(this))))
                || _flag(reg, abi.encodeCall(IAccessRegistry.isBlocked, (seizeTo)))
        ) return HOLD_TOKEN_BLOCKED;
        (ok, w) = _read(token, abi.encodeCall(IStockToken.effectiveAt, ()));
        uint256 effectiveAt = ok ? w : 0;
        if (effectiveAt != 0 && (effectiveAt > block.timestamp || block.timestamp - effectiveAt < multiplierCooldown)) {
            return HOLD_MULTIPLIER;
        }
        return _feedHold(assets[token].feed, effectiveAt);
    }

    /// @dev The feed's side of the holds. HOLD_MULTIPLIER while the token's multiplier took effect after the feed's
    ///      latest answer (the feed has not caught up: its price is still per the old share count). HOLD_PRICE_MOVED
    ///      unless the latest answer is within `maxJumpBps` of the rounds 1, 2, 4 ... before it, down to one published
    ///      `jumpWindow` or more ago: a jump anywhere in the window (the first round of a split the feed's multiplier
    ///      lags, and every round after it until the multiplier catches up) holds new credit. A round that cannot be
    ///      read, a window with more rounds than JUMP_SAMPLES reach, or a feed younger than the window (a new phase)
    ///      holds it too: history that cannot be checked is not trusted.
    function _feedHold(address feed, uint256 effectiveAt) internal view returns (uint8) {
        uint80 id;
        uint256 price;
        try IPriceFeed(feed).latestRoundData() returns (uint80 r, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return HOLD_PRICE_MOVED;
            if (effectiveAt > updatedAt) return HOLD_MULTIPLIER;
            (id, price) = (r, uint256(answer));
        } catch {
            return HOLD_PRICE_MOVED;
        }
        return _priceSettled(feed, id, price) ? 0 : HOLD_PRICE_MOVED;
    }

    /// @dev The jump walk of `_feedHold`, from the latest round `id` at `price`.
    function _priceSettled(address feed, uint80 id, uint256 price) internal view returns (bool) {
        uint256 since = block.timestamp > jumpWindow ? block.timestamp - jumpWindow : 0;
        uint256 inPhase = uint64(id); // a Chainlink proxy's round id is phase << 64 | the aggregator's round
        uint256 back = 1;
        for (uint256 i; i < JUMP_SAMPLES; ++i) {
            if (back >= inPhase) back = inPhase - 1; // at most back to the phase's first round
            if (back == 0) return false; // no round before the latest in this phase
            try IPriceFeed(feed).getRoundData(uint80(id - back)) returns (
                uint80, int256 old, uint256, uint256 at, uint80
            ) {
                if (old <= 0 || at == 0) return false;
                uint256 o = uint256(old);
                uint256 diff = price > o ? price - o : o - price;
                if (diff * 10_000 > o * maxJumpBps) return false;
                if (at <= since) return true;
            } catch {
                return false;
            }
            if (back == inPhase - 1) return false; // the phase's first round is still inside the window
            back <<= 1;
        }
        return false;
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

    function _flag(address target, bytes memory data) internal view returns (bool) {
        (bool ok, uint256 w) = _read(target, data);
        return ok && w != 0;
    }

    /// @dev See the contract's notice: at most `sessionMaxAge` old, or the week's last price (published on a Friday or
    ///      Saturday, UTC) until Tuesday 06:00 UTC; never older than `maxAge`.
    function _fresh(uint256 updatedAt, uint64 maxAge) internal view returns (bool) {
        uint256 age = block.timestamp - updatedAt;
        if (age > maxAge) return false;
        if (age <= sessionMaxAge) return true;
        uint256 day = updatedAt / 1 days;
        uint256 weekday = (day + 4) % 7; // 0 Sunday … 5 Friday, 6 Saturday (1 January 1970 was a Thursday)
        if (weekday < 5) return false;
        uint256 tuesday = day + (weekday == 5 ? 4 : 3);
        return block.timestamp < tuesday * 1 days + 6 hours;
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

    /// @dev Close (`seize` false: every token back to the depositor; with `refund`, the line back in this epoch's
    ///      budget) or seize (`seize` true: every token to `seizeTo`) an open position. "Every token" is the
    ///      position's share of what the vault still holds of it (_payout).
    function _end(uint256 id, Position storage p, bool seize, bool refund) internal {
        p.status = seize ? Status.Seized : Status.Closed;
        address token = p.token;
        uint256 out = _payout(token, p.amount);
        held[token] -= p.amount;
        openLines -= p.line;
        openLinesOf[token] -= p.line;
        if (seize) {
            IERC20(token).safeTransfer(seizeTo, out);
            emit Seized(id, seizeTo, token, out);
        } else {
            if (refund && p.openedAt >= epochStart) {
                uint256 line = p.line;
                linedThisEpoch -= line < linedThisEpoch ? line : linedThisEpoch;
            }
            IERC20(token).safeTransfer(p.depositor, out);
            emit Closed(id, p.depositor, out);
        }
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
        bytes memory ret;
        (ok, ret) = token.call(abi.encodeCall(IERC20.transfer, (p.depositor, out)));
        if (!ok || (ret.length != 0 && (ret.length < 32 || uint256(bytes32(ret)) != 1))) return false;
        held[token] = owed - p.amount;
        p.status = Status.Closed;
        emit Closed(id, p.depositor, out);
        return true;
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
