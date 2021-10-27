'use strict';

const BigNumber = require('bignumber.js');
const Web3 = require('web3');

const {
    Finding,
    FindingSeverity,
    FindingType,
    getJsonRpcUrl
} = require('forta-agent');

const web3 = new Web3(getJsonRpcUrl());

const C_TOKEN_NAME = 'cBAT';

const C_TOKEN_ADDRESS = '0x6C8c6b02E7b2BE14d4fA6022Dfd6d75921D90E4E';
const TOKEN_ADDRESS = '0x0d8775f648430679a709e98d2b0cb6250d2887ef';

const BORROW_EVENT = 'Borrow(address,uint256,uint256,uint256)';
const TRANSFER_EVENT = 'Transfer(address,address,uint256)';
const ACCRUE_INTEREST = 'AccrueInterest(uint256,uint256,uint256)';
const REPAY_BORROW = 'RepayBorrow(address,address,uint256,uint256,uint256)';
const RESERVED_REDUCED = 'ReservesReduced(address,uint256,uint256)';

const cTokenAbi = require(`./${C_TOKEN_NAME}.json`);
const cToken = new web3.eth.Contract(cTokenAbi, C_TOKEN_ADDRESS);

let totalCash;
let totalBorrows;
let totalReserves;
let totalSupply;
let reserveFactor;
let exchangeRate;

const handleTransaction = async (txEvent) => {
    const findings = [];

    const toAddress = txEvent.to.toLowerCase();

    if (toAddress !== C_TOKEN_ADDRESS) {
        return findings;
    }

    const block = txEvent.block.number;

    if (exchangeRate === undefined) {
        totalCash = await getTotalCash(cToken, block);
        totalBorrows = await getTotalBorrows(cToken, block);
        totalReserves = await getTotalReserves(cToken, block);
        totalSupply = await getTotalSupply(cToken, block);
        reserveFactor = await getReserveFactor(cToken, block);

        exchangeRate = calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);

        // DEBUG
        console.log('totalCash', totalCash.toFixed(10));
        console.log('totalBorrows', totalBorrows.toFixed(10));
        console.log('totalReserves', totalReserves.toFixed(10));
        console.log('totalSupply', totalSupply.toFixed(10));
        console.log('reserveFactor', reserveFactor.toFixed(10));
        console.log('exchangeRate', exchangeRate.toFixed(10));

        // DEBUG
        const exchangeRateStored = await cToken.methods.exchangeRateStored().call(undefined, block);
        console.log('exchangeRateStored', exchangeRateStored);

        // DEBUG
        const exchangeRateCurrent = await cToken.methods.exchangeRateCurrent().call(undefined, block);
        console.log('exchangeRateCurrent', exchangeRateCurrent);

        console.log();

        return findings;
    }

    let exchangeRateNew;

    const borrowEvents = txEvent.filterEvent(BORROW_EVENT);

    for (const borrowEvent of borrowEvents) {
        exchangeRateNew = updateBorrowEvent(borrowEvent);
    }

    const transferEvents = txEvent.filterEvent(TRANSFER_EVENT);

    for (const transferEvent of transferEvents) {
        exchangeRateNew = updateTransferEvent(transferEvent, C_TOKEN_ADDRESS, TOKEN_ADDRESS);
    }

    const accrueInterestEvents = txEvent.filterEvent(ACCRUE_INTEREST);

    for (const accrueInterestEvent of accrueInterestEvents) {
        exchangeRateNew = updateAccrueInterestEvent(accrueInterestEvent);
    }

    const repayBorrowEvents = txEvent.filterEvent(REPAY_BORROW);

    for (const repayBorrowEvent of repayBorrowEvents) {
        exchangeRateNew = updateRepayBorrowEvent(repayBorrowEvent);
    }

    const reservesReducedEvents = txEvent.filterEvent(RESERVED_REDUCED);

    for (const reservesReducedEvent of reservesReducedEvents) {
        exchangeRateNew = updateReservesReducedEvent(reservesReducedEvent);
    }

    if (exchangeRateNew !== undefined && exchangeRateNew.isLessThan(exchangeRate)) {
        const cTokenNameUpper = C_TOKEN_NAME.toUpperCase();

        findings.push(
            Finding.fromObject({
                name: 'Compound Token Exchange Rate Goes Down',
                description: `Compound token (${C_TOKEN_NAME}) exchange rate goes down`,
                alertId: `COMPOUND-${cTokenNameUpper}-EXCHANGE-RATE-DOWN-1`,
                severity: FindingSeverity.Medium,
                type: FindingType.Info
            })
        );
    }

    return findings;
};

function updateBorrowEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['address', 'uint256', 'uint256', 'uint256'], event.data);
    totalBorrows = new BigNumber(parsedData[3]);
    return updateExchangeRate();
}

function updateRepayBorrowEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['address', 'address', 'uint256', 'uint256', 'uint256'], event.data);
    totalBorrows = new BigNumber(parsedData[4]);
    return updateExchangeRate();
}

function updateReservesReducedEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['address', 'uint256', 'uint256'], event.data);
    totalReserves = new BigNumber(parsedData[2]);
    return updateExchangeRate();
}

function updateAccrueInterestEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['uint256', 'uint256', 'uint256'], event.data);
    totalBorrows = new BigNumber(parsedData[2]);

    const interestAccumulated = new BigNumber(parsedData[0]);

    totalReserves = totalReserves.plus(interestAccumulated.multipliedBy(reserveFactor).div(Math.pow(10, 18)));
    return updateExchangeRate();
}

function updateTransferEvent(event, cTokenAddress, tokenAddress) {
    const parsedTopic1 = web3.eth.abi.decodeParameters(['address'], event.topics[1]);
    const parsedTopic2 = web3.eth.abi.decodeParameters(['address'], event.topics[2]);

    const fromAddress = parsedTopic1[0].toLowerCase();
    const toAddress = parsedTopic2[0].toLowerCase();

    const eventAddress = event.address.toLowerCase();

    const parsedData = web3.eth.abi.decodeParameters(['uint256'], event.data);
    const value = new BigNumber(parsedData[0]);

    if (eventAddress === cTokenAddress) {
        if (fromAddress === cTokenAddress) {
            totalSupply = totalSupply.plus(value);
            console.log('updateTransfer totalSupply + ', value.toFixed(10));

            return updateExchangeRate();
        } else if (toAddress === cTokenAddress) {
            totalSupply = totalSupply.minus(value);
            console.log('updateTransfer totalSupply - ', value.toFixed(10));

            return updateExchangeRate();
        } else {
            console.warn('C_TOKEN_ADDRESS not in transaction!');
        }
    } else if (eventAddress === tokenAddress) {
        if (fromAddress === cTokenAddress) {
            totalCash = totalCash.minus(value);
            console.log('updateTransfer totalCash - ', value.toFixed(10));

            return updateExchangeRate();
        } else if (toAddress === cTokenAddress) {
            totalCash = totalCash.plus(value);
            console.log('updateTransfer totalCash + ', value.toFixed(10));

            return updateExchangeRate();
        } else {
            console.warn('C_TOKEN_ADDRESS not in transaction!');
        }
    } else {
        console.warn('eventAddress not found!');
    }
}

function updateExchangeRate() {
    return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
}

function calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply) {
    return new BigNumber(totalCash.plus(totalBorrows).minus(totalReserves).div(totalSupply));
}

async function getTotalCash(cToken, block) {
    return new BigNumber(await cToken.methods.getCash().call(undefined, block));
}

async function getTotalBorrows(cToken, block) {
    return new BigNumber(await cToken.methods.totalBorrows().call(undefined, block));
}

async function getTotalReserves(cToken, block) {
    return new BigNumber(await cToken.methods.totalReserves().call(undefined, block));
}

async function getTotalSupply(cToken, block) {
    return new BigNumber(await cToken.methods.totalSupply().call(undefined, block));
}

async function getReserveFactor(cToken, block) {
    return new BigNumber(await cToken.methods.reserveFactorMantissa().call(undefined, block));
}

module.exports = {
    handleTransaction
};
