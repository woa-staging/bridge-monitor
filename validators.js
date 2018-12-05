require('dotenv').config()
const Web3 = require('web3')
const fetch = require('node-fetch')
const logger = require('./logger')('validators')
const { getBridgeABIs } = require('./utils/bridgeMode')

const {
  HOME_RPC_URL,
  FOREIGN_RPC_URL,
  HOME_BRIDGE_ADDRESS,
  FOREIGN_BRIDGE_ADDRESS,
  GAS_PRICE_SPEED_TYPE,
  GAS_LIMIT,
  GAS_PRICE_FALLBACK
} = process.env
const HOME_DEPLOYMENT_BLOCK = Number(process.env.HOME_DEPLOYMENT_BLOCK) || 0
const FOREIGN_DEPLOYMENT_BLOCK = Number(process.env.FOREIGN_DEPLOYMENT_BLOCK) || 0

const Web3Utils = Web3.utils

const homeProvider = new Web3.providers.HttpProvider(HOME_RPC_URL)
const web3Home = new Web3(homeProvider)

const foreignProvider = new Web3.providers.HttpProvider(FOREIGN_RPC_URL)
const web3Foreign = new Web3(foreignProvider)

const BRIDGE_VALIDATORS_ABI = require('./abis/BridgeValidators.abi')

const asyncForEach = async (array, callback) => {
  for (let index = 0; index < array.length; index++) {
    await callback(array[index], index, array)
  }
}

async function getGasPrices(type) {
  try {
    const response = await fetch('https://gasprice.poa.network/')
    const json = await response.json()
    logger.log('Fetched gasprice: ' + json[type])
    return json[type]
  } catch (e) {
    logger.error('Gas Price API is not available', e)
    return GAS_PRICE_FALLBACK
  }
}

async function main(bridgeMode) {
  try {
    const { HOME_ABI, FOREIGN_ABI } = getBridgeABIs(bridgeMode)
    const homeBridge = new web3Home.eth.Contract(HOME_ABI, HOME_BRIDGE_ADDRESS)
    const foreignBridge = new web3Foreign.eth.Contract(FOREIGN_ABI, FOREIGN_BRIDGE_ADDRESS)
    const homeValidatorsAddress = await homeBridge.methods.validatorContract().call()
    const homeBridgeValidators = new web3Home.eth.Contract(
      BRIDGE_VALIDATORS_ABI,
      homeValidatorsAddress
    )

    logger.debug('calling foreignBridge.methods.validatorContract().call()')
    const foreignValidatorsAddress = await foreignBridge.methods.validatorContract().call()
    const foreignBridgeValidators = new web3Foreign.eth.Contract(
      BRIDGE_VALIDATORS_ABI,
      foreignValidatorsAddress
    )
    logger.debug("calling foreignBridgeValidators.getPastEvents('ValidatorAdded')")
    const ValidatorAddedForeign = await foreignBridgeValidators.getPastEvents('ValidatorAdded', {
      fromBlock: FOREIGN_DEPLOYMENT_BLOCK
    })
    logger.debug("calling foreignBridgeValidators.getPastEvents('ValidatorRemoved')")
    const ValidatorRemovedForeign = await foreignBridgeValidators.getPastEvents(
      'ValidatorRemoved',
      {
        fromBlock: FOREIGN_DEPLOYMENT_BLOCK
      }
    )
    let foreignValidators = ValidatorAddedForeign.map(val => {
      return val.returnValues.validator
    })
    const foreignRemovedValidators = ValidatorRemovedForeign.map(val => {
      return val.returnValues.validator
    })
    foreignValidators = foreignValidators.filter(val => !foreignRemovedValidators.includes(val))
    logger.debug("calling homeBridgeValidators.getPastEvents('ValidatorAdded')")
    const ValidatorAdded = await homeBridgeValidators.getPastEvents('ValidatorAdded', {
      fromBlock: HOME_DEPLOYMENT_BLOCK
    })
    logger.debug("calling homeBridgeValidators.getPastEvents('ValidatorRemoved')")
    const ValidatorRemoved = await homeBridgeValidators.getPastEvents('ValidatorRemoved', {
      fromBlock: HOME_DEPLOYMENT_BLOCK
    })
    let homeValidators = ValidatorAdded.map(val => {
      return val.returnValues.validator
    })
    const homeRemovedValidators = ValidatorRemoved.map(val => {
      return val.returnValues.validator
    })
    homeValidators = homeValidators.filter(val => !homeRemovedValidators.includes(val))
    const homeBalances = {}
    logger.debug('calling asyncForEach homeValidators homeBalances')
    await asyncForEach(homeValidators, async v => {
      homeBalances[v] = Web3Utils.fromWei(await web3Home.eth.getBalance(v))
    })
    const foreignVBalances = {}
    const homeVBalances = {}
    logger.debug('calling getGasPrices')
    const gasPriceInGwei = await getGasPrices(GAS_PRICE_SPEED_TYPE)
    const gasPrice = new Web3Utils.BN(Web3Utils.toWei(gasPriceInGwei.toString(10), 'gwei'))
    const txCost = gasPrice.mul(new Web3Utils.BN(GAS_LIMIT))
    let validatorsMatch = true
    logger.debug('calling asyncForEach foreignValidators foreignVBalances')
    await asyncForEach(foreignValidators, async v => {
      const balance = await web3Foreign.eth.getBalance(v)
      const leftTx = new Web3Utils.BN(balance).div(txCost).toString(10)
      foreignVBalances[v] = {
        balance: Web3Utils.fromWei(balance),
        leftTx: Number(leftTx),
        gasPrice: gasPriceInGwei
      }
      if(!homeValidators.includes(v)) {
        validatorsMatch = false
        foreignVBalances[v].onlyOnForeign = true
      }
    })
    logger.debug('calling asyncForEach homeValidators homeVBalances')
    await asyncForEach(homeValidators, async v => {
      const gasPrice = new Web3Utils.BN(1)
      const txCost = gasPrice.mul(new Web3Utils.BN(GAS_LIMIT))
      const balance = await web3Home.eth.getBalance(v)
      const leftTx = new Web3Utils.BN(balance).div(txCost).toString(10)
      homeVBalances[v] = {
        balance: Web3Utils.fromWei(balance),
        leftTx: Number(leftTx),
        gasPrice: Number(gasPrice.toString(10))
      }
      if(!foreignValidators.includes(v)) {
        validatorsMatch = false
        homeVBalances[v].onlyOnHome = true
      }
    })
    logger.debug('Done')
    return {
      home: {
        validators: {
          ...homeVBalances
        }
      },
      foreign: {
        validators: {
          ...foreignVBalances
        }
      },
      validatorsMatch,
      lastChecked: Math.floor(Date.now() / 1000)
    }
  } catch (e) {
    logger.error(e)
    throw e
  }
}

module.exports = main
