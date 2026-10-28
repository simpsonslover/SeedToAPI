// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// Minimal tokens for tests only.
contract TestToken {
    string public symbol = "TST";
    uint8 public decimals = 6;
    mapping(address => uint256) public balanceOf;

    constructor(address holder, uint256 amount) { balanceOf[holder] = amount; }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

contract TestNFT {
    mapping(uint256 => address) public ownerOf;

    constructor(address holder) { ownerOf[1] = holder; }

    function safeTransferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from && msg.sender == from, "not owner");
        ownerOf[id] = to;
    }
}
