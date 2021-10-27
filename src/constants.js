'use strict';

const C_TOKEN_NAME = 'cBAT';

const C_TOKEN_ADDRESS = '0x6c8c6b02e7b2be14d4fa6022dfd6d75921d90e4e';
const TOKEN_ADDRESS = '0x0d8775f648430679a709e98d2b0cb6250d2887ef';

const TRANSFER_EVENT = 'Transfer(address,address,uint256)';
const ACCRUE_INTEREST = 'AccrueInterest(uint256,uint256,uint256)';
const BORROW_EVENT = 'Borrow(address,uint256,uint256,uint256)';
const REPAY_BORROW = 'RepayBorrow(address,address,uint256,uint256,uint256)';
const RESERVED_REDUCED = 'ReservesReduced(address,uint256,uint256)';

module.exports = {
    C_TOKEN_NAME,
    C_TOKEN_ADDRESS,
    TOKEN_ADDRESS,
    TRANSFER_EVENT,
    ACCRUE_INTEREST,
    BORROW_EVENT,
    REPAY_BORROW,
    RESERVED_REDUCED
}
