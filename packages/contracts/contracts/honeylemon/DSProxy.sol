// This is the DS proxy implementation taken from: https://github.com/dapphub/ds-proxy
// This contract and it's deployment along with the HoneyLemon Market Contract Proxy
// enable bulk redemption of long or short tokens by traders. At position creation
// the miner and investor's tokens are sent to the DSProxy. This proxy acts as a wallet
// for the miner and investor which only they can access (think smart contract wallet).
// At redemption time the user can use the DSProxy to execute batch transaction on their
// behalf by calling a `script` within the `MarketContractProxy`. DSProxy uses delegate
// call and as such this function execution can modify state within the DSProxy, without
// the DSProxy needing to story the logic for unwinding. This implementation is mostly
// the same as the stock dapphub version except for one new modifier.

pragma solidity 0.5.2;


contract DSNote {
    event LogNote(
        bytes4 indexed sig,
        address indexed guy,
        bytes32 indexed foo,
        bytes32 bar,
        uint wad,
        bytes fax
    );

    modifier note {
        bytes32 foo;
        bytes32 bar;

        assembly {
            foo := calldataload(4)
            bar := calldataload(36)
        }
        emit LogNote(msg.sig, msg.sender, foo, bar, msg.value, msg.data);

        _;
    }
}


contract DSAuthority {
    function canCall(
        address src,
        address dst,
        bytes4 sig
    ) public view returns (bool);
}


contract DSAuthEvents {
    event LogSetAuthority(address indexed authority);
    event LogSetOwner(address indexed owner);
}


contract DSAuth is DSAuthEvents {
    DSAuthority public authority;
    address public owner;

    constructor() public {
        owner = msg.sender;
        emit LogSetOwner(msg.sender);
    }

    function setOwner(address owner_) public auth {
        owner = owner_;
        emit LogSetOwner(owner);
    }

    function setAuthority(DSAuthority authority_) public auth {
        authority = authority_;
        emit LogSetAuthority(address(authority));
    }

    modifier auth {
        require(isAuthorized(msg.sender, msg.sig));
        _;
    }

    function isAuthorized(address src, bytes4 sig) internal view returns (bool) {
        if (src == address(this)) {
            return true;
        } else if (src == owner) {
            return true;
        } else if (authority == DSAuthority(0)) {
            return false;
        } else {
            return authority.canCall(src, address(this), sig);
        }
    }
}


// DSProxy
// Allows code execution using a persistant identity This can be very
// useful to execute a sequence of atomic actions. Since the owner of
// the proxy can be changed, this allows for dynamic ownership models
// i.e. a multisig
contract DSProxy is DSAuth, DSNote {
    function() external payable {}

    function execute(address _target, bytes memory _data)
        public
        payable
        auth
        note
        returns (bytes memory response)
    {
        require(_target != address(0), 'ds-proxy-target-address-required');

        // call contract in current context
        assembly {
            let succeeded := delegatecall(
                sub(gas, 5000),
                _target,
                add(_data, 0x20),
                mload(_data),
                0,
                0
            )
            let size := returndatasize

            response := mload(0x40)
            mstore(0x40, add(response, and(add(add(size, 0x20), 0x1f), not(0x1f))))
            mstore(response, size)
            returndatacopy(add(response, 0x20), 0, size)

            switch iszero(succeeded)
                case 1 {
                    // throw if delegatecall failed
                    revert(add(response, 0x20), size)
                }
        }
    }
}


// DSProxyFactory
// This factory deploys new proxy instances through build()
// Deployed proxy addresses are logged
contract DSProxyFactory {
    event Created(address indexed sender, address indexed owner, address proxy);
    mapping(address => bool) public isProxy;
    address marketContractProxy;

    constructor() public {
        marketContractProxy = msg.sender;
    }

    modifier onlyMarketContractProxy() {
        require(
            msg.sender == marketContractProxy,
            'Only callable by MarketContractProxy'
        );
        _;
    }

    // deploys a new proxy instance
    // sets custom owner of proxy
    function build(address owner)
        public
        onlyMarketContractProxy()
        returns (address payable proxy)
    {
        proxy = address(new DSProxy());
        emit Created(msg.sender, owner, address(proxy));
        DSProxy(proxy).setOwner(owner);
        isProxy[proxy] = true;
    }

    // deploys a new proxy instance
    // sets owner of proxy to caller
    function build() internal returns (address payable proxy) {
        proxy = build(msg.sender);
    }
}
