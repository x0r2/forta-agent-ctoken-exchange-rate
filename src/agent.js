'use strict';

const BigNumber = require('bignumber.js');
const Web3 = require('web3');

const {
    createTransactionEvent
} = require('forta-agent');

const {
    C_TOKEN_NAME,
    C_TOKEN_ADDRESS,
    TOKEN_ADDRESS,
    TRANSFER_EVENT,
    ACCRUE_INTEREST,
    BORROW_EVENT,
    REPAY_BORROW,
    RESERVED_REDUCED
} = require('./constants.js');

const web3 = new Web3('https://eth-mainnet.gateway.pokt.network/v1/5f3453978e354ab992c4da79');

const cTokenAbi = require(`./${C_TOKEN_NAME}.json`);
const cToken = new web3.eth.Contract(cTokenAbi, C_TOKEN_ADDRESS);

const EXP = Math.pow(10, 18);

let totalCash;
let totalSupply;
let totalBorrows;
let totalReserves;
let reserveFactor;
let exchangeRate;

const handleTransaction = async (txEvent) => {
    const findings = [];

    txEvent = createTransactionEvent(txEvent);
    let toAddress = txEvent.transaction.to;

    if (!toAddress) {
        return findings;
    }

    toAddress = toAddress.toLowerCase();

    if (toAddress !== C_TOKEN_ADDRESS) {
        return findings;
    }

    const block = txEvent.block.number;

    // DEBUG
    console.log('\nBlock', block);
    console.log();

    if (exchangeRate === undefined) {
        [totalCash, totalSupply, totalBorrows, totalReserves, reserveFactor] = await Promise.all([
            getTotalCash(cToken, block),
            getTotalSupply(cToken, block),
            getTotalBorrows(cToken, block),
            getTotalReserves(cToken, block),
            getReserveFactor(cToken, block)
        ]);

        exchangeRate = calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);

        // DEBUG
        console.log('Init totalCash', totalCash.toFixed(5));
        console.log('Init totalSupply', totalSupply.toFixed(5));
        console.log('Init totalBorrows', totalBorrows.toFixed(5));
        console.log('Init totalReserves', totalReserves.toFixed(5));
        console.log('Init reserveFactor', reserveFactor.toFixed(5));
        console.log('Init exchangeRate', exchangeRate.toFixed(5));

        // DEBUG
        const exchangeRateStored = await cToken.methods.exchangeRateStored().call(undefined, block);
        const exchangeRateCurrent = await cToken.methods.exchangeRateCurrent().call(undefined, block);

        // DEBUG
        console.log('exchangeRateStored', exchangeRateStored);
        console.log('exchangeRateCurrent', exchangeRateCurrent);
        console.log();

        return findings;
    }

    let exchangeRateNew;

    const transferEvents = txEvent.filterEvent(TRANSFER_EVENT);

    for (const transferEvent of transferEvents) {
        exchangeRateNew = updateTransferEvent(transferEvent, C_TOKEN_ADDRESS, TOKEN_ADDRESS);
    }

    const accrueInterestEvents = txEvent.filterEvent(ACCRUE_INTEREST);

    for (const accrueInterestEvent of accrueInterestEvents) {
        exchangeRateNew = updateAccrueInterestEvent(accrueInterestEvent);
    }

    const borrowEvents = txEvent.filterEvent(BORROW_EVENT);

    for (const borrowEvent of borrowEvents) {
        exchangeRateNew = updateBorrowEvent(borrowEvent);
    }

    const repayBorrowEvents = txEvent.filterEvent(REPAY_BORROW);

    for (const repayBorrowEvent of repayBorrowEvents) {
        exchangeRateNew = updateRepayBorrowEvent(repayBorrowEvent);
    }

    const reservesReducedEvents = txEvent.filterEvent(RESERVED_REDUCED);

    for (const reservesReducedEvent of reservesReducedEvents) {
        exchangeRateNew = updateReservesReducedEvent(reservesReducedEvent);
    }

    if (exchangeRateNew) {
        // DEBUG
        console.log('exchangeRateNew', exchangeRateNew.toFixed(5));

        if (exchangeRateNew.isLessThan(exchangeRate)) {
            console.log('ALERT!');
        }

        exchangeRate = exchangeRateNew;

        // DEBUG
        console.log('\nCALCULATED EXCHANGE RATE', exchangeRate.toFixed(5));
        console.log();

        const [totalCashS, totalSupplyS, totalBorrowsS, totalReservesS, reserveFactorS] = await Promise.all([
            getTotalCash(cToken, block),
            getTotalSupply(cToken, block),
            getTotalBorrows(cToken, block),
            getTotalReserves(cToken, block),
            getReserveFactor(cToken, block)
        ]);

        console.log('totalCash', totalCashS.toFixed(5), totalCash.toFixed(5));
        console.log('totalSupply', totalSupplyS.toFixed(5), totalSupply.toFixed(5));
        console.log('totalBorrows', totalBorrowsS.toFixed(5), totalBorrows.toFixed(5));
        console.log('totalReserves', totalReservesS.toFixed(5), totalReserves.toFixed(5));
        console.log('reserveFactor', reserveFactorS.toFixed(5), reserveFactor.toFixed(5));

        // DEBUG
        const exchangeRateStored = await cToken.methods.exchangeRateStored().call(undefined, block);
        const exchangeRateCurrent = await cToken.methods.exchangeRateCurrent().call(undefined, block);

        // DEBUG
        console.log('exchangeRateStored', exchangeRateStored);
        console.log('exchangeRateCurrent', exchangeRateCurrent);
        console.log();
    }

    return findings;
};

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

            // DEBUG
            console.log('updateTransfer totalSupply +', value.toFixed(5));

            return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
        } else if (toAddress === cTokenAddress) {
            totalSupply = totalSupply.minus(value);

            // DEBUG
            console.log('updateTransfer totalSupply -', value.toFixed(5));

            return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
        } else {
            console.log(toAddress, fromAddress);
            console.warn('cTokenAddress not in transaction!');
        }
    } else if (eventAddress === tokenAddress) {
        if (fromAddress === cTokenAddress) {
            totalCash = totalCash.minus(value);

            // DEBUG
            console.log('updateTransfer totalCash -', value.toFixed(5));

            return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
        } else if (toAddress === cTokenAddress) {
            totalCash = totalCash.plus(value);

            // DEBUG
            console.log('updateTransfer totalCash +', value.toFixed(5));

            return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
        } else {
            console.warn('cTokenAddress not in transaction!');
        }
    } else {
        console.warn('eventAddress not found!');
    }
}

function updateAccrueInterestEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['uint256', 'uint256', 'uint256'], event.data);
    totalBorrows = new BigNumber(parsedData[2]);

    const interestAccumulated = new BigNumber(parsedData[0]);

    totalReserves = calcTotalReserves(totalReserves, interestAccumulated, reserveFactor);

    // DEBUG
    console.log('updateAccrueInterestEvent', totalBorrows.toFixed(5), totalReserves.toFixed(5));

    return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
}

function updateBorrowEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['address', 'uint256', 'uint256', 'uint256'], event.data);
    totalBorrows = new BigNumber(parsedData[3]);

    // DEBUG
    console.log('updateBorrowEvent', totalBorrows.toFixed(5));

    return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
}

function updateRepayBorrowEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['address', 'address', 'uint256', 'uint256', 'uint256'], event.data);
    totalBorrows = new BigNumber(parsedData[4]);

    // DEBUG
    console.log('updateRepayBorrowEvent', totalBorrows.toFixed(5));

    return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
}

function updateReservesReducedEvent(event) {
    const parsedData = web3.eth.abi.decodeParameters(['address', 'uint256', 'uint256'], event.data);
    totalReserves = new BigNumber(parsedData[2]);

    // DEBUG
    console.log('updateReservesReducedEvent', totalReserves.toFixed(5));

    return calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply);
}

function calcExchangeRate(totalCash, totalBorrows, totalReserves, totalSupply) {
    return totalCash.plus(totalBorrows).minus(totalReserves).div(totalSupply).multipliedBy(EXP);
}

function calcTotalReserves(totalReserves, interestAccumulated, reserveFactor) {
    return new BigNumber(totalReserves.plus(interestAccumulated.multipliedBy(reserveFactor).div(EXP)).toFixed(0));
}

async function getTotalCash(cToken, block) {
    return new BigNumber(await cToken.methods.getCash().call(undefined, block));
}

async function getTotalSupply(cToken, block) {
    return new BigNumber(await cToken.methods.totalSupply().call(undefined, block));
}

async function getTotalBorrows(cToken, block) {
    return new BigNumber(await cToken.methods.totalBorrows().call(undefined, block));
}

async function getTotalReserves(cToken, block) {
    return new BigNumber(await cToken.methods.totalReserves().call(undefined, block));
}

async function getReserveFactor(cToken, block) {
    return new BigNumber(await cToken.methods.reserveFactorMantissa().call(undefined, block));
}

module.exports = {
    handleTransaction
};
