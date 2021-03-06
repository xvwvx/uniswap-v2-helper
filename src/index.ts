import { Signer, ethers } from 'ethers'
import { Provider } from '@ethersproject/providers'
import { TransactionReceipt } from '@ethersproject/providers'
import * as IUniswapV2ERC20 from '@uniswap/v2-core/build/IUniswapV2ERC20.json'
import * as IUniswapV2Router from '@uniswap/v2-periphery/build/IUniswapV2Router02.json'
import * as IUniswapV2Pair from '@uniswap/v2-periphery/build/IUniswapV2Pair.json'
import * as IUniswapV2Factory from '@uniswap/v2-periphery/build/IUniswapV2Factory.json'
import { Decimal } from 'decimal.js'

export const UniswapRouterAddress = '0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D'

// @thegostep todo: #5 add documentation on default slippage and delay
// @thegostep todo: #6 add support for multiple token path

/**
 * Get parameters to perform a direct swap between two tokens.
 *
 * Calculates price based on current price on the contracts.
 * Only supports direct erc20 token pairs with a decimals getters.
 */
export async function getSwapParams(
  inputToken: string,
  outputToken: string,
  amount: string,
  isSellOrder: boolean,
  {
    maxSlippage = 100,
    maxDelay = 60 * 2,
    ethersProvider = ethers.getDefaultProvider() as Provider,
  },
): Promise<{
  amountIn: string
  amountOut: string
  expectedAmount: string
  expectedSlippage: string
  path: string[]
  deadline: number
}> {
  // get provider
  const provider = ethersProvider

  // format addresses
  inputToken = ethers.utils.getAddress(inputToken)
  outputToken = ethers.utils.getAddress(outputToken)

  // create contract instances
  const InputToken = new ethers.Contract(
    inputToken,
    IUniswapV2ERC20.abi,
    provider,
  )
  const OutputToken = new ethers.Contract(
    outputToken,
    IUniswapV2ERC20.abi,
    provider,
  )
  const UniswapRouter = new ethers.Contract(
    UniswapRouterAddress,
    IUniswapV2Router.abi,
    provider,
  )
  const Factory = new ethers.Contract(
    await UniswapRouter.factory(),
    IUniswapV2Factory.abi,
    provider,
  )
  const Pair = new ethers.Contract(
    await Factory.getPair(InputToken.address, OutputToken.address),
    IUniswapV2Pair.abi,
    provider,
  )

  // get decimals
  const inputDecimals = await InputToken.decimals()
  const outputDecimals = await OutputToken.decimals()

  // format amount
  let inputAmount, outputAmount
  if (isSellOrder) {
    inputAmount = ethers.utils.parseUnits(amount, inputDecimals)
  } else {
    outputAmount = ethers.utils.parseUnits(amount, outputDecimals)
  }

  // set path
  const path = [inputToken, outputToken]

  // set deadline
  const currentTimestamp = (await provider.getBlock('latest')).timestamp
  const deadline = currentTimestamp + maxDelay

  // get expected amount
  const expectedAmount = isSellOrder
    ? (await UniswapRouter.getAmountsOut(inputAmount, path))[1]
    : (await UniswapRouter.getAmountsIn(outputAmount, path))[0]

  // set safety amount
  const safetyAmount = isSellOrder
    ? expectedAmount.mul(
        ethers.BigNumber.from(1).sub(
          ethers.BigNumber.from(maxSlippage).div(10000),
        ),
      )
    : expectedAmount.mul(
        ethers.BigNumber.from(1).add(
          ethers.BigNumber.from(maxSlippage).div(10000),
        ),
      )

  // get token order
  const inputIs0 = (await Pair.token0()) === InputToken.address

  // get quotes
  const { reserve0, reserve1 } = await Pair.getReserves()
  const inputUnit = ethers.utils.parseUnits('1', await InputToken.decimals())
  const outputPerInputQuotePre = inputIs0
    ? inputUnit.mul(reserve1).div(reserve0)
    : inputUnit.mul(reserve0).div(reserve1)

  let reserve0Post
  let reserve1Post
  if (isSellOrder) {
    reserve0Post = inputIs0
      ? reserve0.add(inputAmount)
      : reserve0.sub(expectedAmount)
    reserve1Post = inputIs0
      ? reserve1.sub(expectedAmount)
      : reserve1.add(inputAmount)
  } else {
    reserve0Post = inputIs0
      ? reserve0.add(inputAmount)
      : reserve0.sub(expectedAmount)
    reserve1Post = inputIs0
      ? reserve1.sub(expectedAmount)
      : reserve1.add(inputAmount)
  }

  const outputPerInputQuotePost = inputIs0
    ? inputUnit.mul(reserve1Post).div(reserve0Post)
    : inputUnit.mul(reserve0Post).div(reserve1Post)

  const expectedSlippage = new Decimal(
    ethers.utils.formatUnits(outputPerInputQuotePost, outputDecimals),
  )
    .sub(ethers.utils.formatUnits(outputPerInputQuotePre, outputDecimals))
    .div(ethers.utils.formatUnits(outputPerInputQuotePre, outputDecimals))
    .mul(100)
    .toString()

  const params = {
    amountIn: isSellOrder ? inputAmount : safetyAmount,
    amountOut: isSellOrder ? safetyAmount : outputAmount,
    expectedAmount,
    expectedSlippage,
    path,
    deadline,
  }

  // return swap params
  return params
}

/**
 * Perform a direct swap between two tokens.
 *
 * Calculates price based on current price on the contracts.
 * Only supports direct erc20 token pairs with a decimals getters.
 */
export async function swapTokens(
  ethersSigner: Signer,
  inputToken: string,
  outputToken: string,
  amount: string,
  isSellOrder: boolean,
  { recipient = '', maxSlippage = 100, maxDelay = 60 * 2 },
): Promise<TransactionReceipt> {
  // resolve recipient
  recipient = recipient === '' ? await ethersSigner.getAddress() : recipient

  // get swap params
  const { amountIn, amountOut, path, deadline } = await getSwapParams(
    inputToken,
    outputToken,
    amount,
    isSellOrder,
    {
      maxSlippage,
      maxDelay,
      ethersProvider: ethersSigner.provider,
    },
  )

  // format addresses
  inputToken = ethers.utils.getAddress(inputToken)

  // create contract instances
  const InputToken = new ethers.Contract(
    inputToken,
    IUniswapV2ERC20.abi,
    ethersSigner,
  )
  const UniswapRouter = new ethers.Contract(
    UniswapRouterAddress,
    IUniswapV2Router.abi,
    ethersSigner,
  )

  // check sufficient balance
  const balance = await InputToken.balanceOf(await ethersSigner.getAddress())
  if (balance.lt(amountIn)) {
    throw new Error('insufficient balance')
  }

  // check sufficient allowance
  const allowance = await InputToken.allowance(
    await ethersSigner.getAddress(),
    UniswapRouter.address,
  )
  if (allowance.lt(amountIn)) {
    await (await InputToken.approve(UniswapRouter.address, amountIn)).wait()
  }

  // perform swap
  const swapTx = await (isSellOrder
    ? await UniswapRouter.swapExactTokensForTokens(
        amountIn,
        amountOut,
        path,
        recipient,
        deadline,
      )
    : await UniswapRouter.swapTokensForExactTokens(
        amountOut,
        amountIn,
        path,
        recipient,
        deadline,
      )
  ).wait()

  // return transaction receipt
  return swapTx
}
