import * as dotenv from 'dotenv';
import { 
    Aptos, 
    Account, 
    Network, 
    AptosConfig, 
    Ed25519Account,
    Ed25519PrivateKey,
    Hex,
} from "@aptos-labs/ts-sdk";
import type { PendingTransactionResponse } from "@aptos-labs/ts-sdk";

import { initTappSDK } from "@tapp-exchange/sdk"; 
import { sendNotification } from './notification.js'; 
import { getCoinBalanceInUnits } from './utils.js'; 

dotenv.config();

// --- ユーティリティ関数 ---
function sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// --- 環境変数の読み込み ---
const PRIVATE_KEY = process.env.PRIVATE_KEY; 
const TAPP_POOL_ID = process.env.TAPP_POOL_ID;
const SWAP_BATCH_SIZE = parseInt(process.env.SWAP_BATCH_SIZE || '50', 10);

const TOKEN_INDEX_APT = parseInt(process.env.TOKEN_IN_INDEX_APT || '0', 10);
const TOKEN_INDEX_KAPT = parseInt(process.env.TOKEN_IN_INDEX_KAPT || '1', 10);

// コインタイプ定数
const APT_COIN_TYPE = "0x1::aptos_coin::AptosCoin";
const KAPT_COIN_TYPE = "0x821c94e69bc7ca058c913b7b5e6b0a5c9fd1523d58723a966fb8c1f5ea888105"; // 確定したkAPTアドレス

// Tapp SDK のインスタンス
let tappSDK: ReturnType<typeof initTappSDK>;

/**
 * Tapp SDKのStable Swapを使用してスワップを実行します。
 * ガス代不足エラーを防ぐため、最大ガス代を制限します。
 */
async function executeTappSwap(
    aptos: Aptos,
    signer: Ed25519Account,
    amountIn: number, 
    slippage: number,
    fromTokenIn: boolean 
): Promise<PendingTransactionResponse> { 

    if (!tappSDK) { throw new Error("Tapp SDKが初期化されていません。"); }
    if (!TAPP_POOL_ID) { throw new Error("TAPP_POOL_IDが設定されていません。"); }
    
    // スワップ方向のインデックス
    const TOKEN_IN_INDEX = fromTokenIn ? TOKEN_INDEX_APT : TOKEN_INDEX_KAPT;
    const TOKEN_OUT_INDEX = fromTokenIn ? TOKEN_INDEX_KAPT : TOKEN_INDEX_APT;
    const pair: [number, number] = [TOKEN_IN_INDEX, TOKEN_OUT_INDEX];
    const a2b = fromTokenIn ? true : false; 

    // 1. スワップ見積もり (Quote) の取得
    const quote = await tappSDK.Swap.getEstSwapAmount({
        poolId: TAPP_POOL_ID,
        amount: amountIn,
        pair: pair,
        a2b: a2b,
        field: 'input',
    });

    if (!quote || quote.error) {
        throw new Error(`スワップ見積もり失敗: ${quote.error?.message || '不明なエラー'}`);
    }
    
    const estimatedAmountOut = quote.amount; 
    const minAmountOut = Math.floor(estimatedAmountOut * (1 - slippage));
    
    // 2. トランザクションペイロードの作成
    const tappPayload = tappSDK.Swap.swapStableTransactionPayload({
        poolId: TAPP_POOL_ID,
        tokenIn: TOKEN_IN_INDEX,
        tokenOut: TOKEN_OUT_INDEX,
        amountIn: amountIn, 
        minAmountOut: minAmountOut,
    });
    
    // 3. Build & Sign & Submit
    
    // APT Decimals (8)
    const DECIMALS = 8;
    // ガス代の上限を0.05 APTに制限 (安全対策)
    //const SAFE_MAX_GAS_APT_DECIMAL = 0.05; 
    //const SAFE_MAX_GAS_UNIT = SAFE_MAX_GAS_APT_DECIMAL * (10 ** DECIMALS); 

    const rawTransaction = await aptos.transaction.build.simple({
        sender: signer.accountAddress, 
        data: {
            function: tappPayload.function, // プロパティ名を function に修正済み
            functionArguments: tappPayload.functionArguments
        },
        //options: {
        //    maxGasAmount: SAFE_MAX_GAS_UNIT, // 最大ガス量を設定
        //}
    });
    
    const senderAuthenticator = aptos.transaction.sign({
        signer: signer,
        transaction: rawTransaction, 
    });
    const submittedTransaction = await aptos.transaction.submit.simple({
        transaction: rawTransaction,
        senderAuthenticator: senderAuthenticator,
    });
    
    return submittedTransaction;
}

/**
 * メインの実行ロジック。
 */
async function main() {
    // 1. 環境変数のチェックと初期化
    if (!PRIVATE_KEY || !TAPP_POOL_ID) {
        await sendNotification("🚨 設定エラー: PRIVATE_KEY, TAPP_POOL_ID のいずれかが設定されていません。");
        console.error("設定エラー: .env ファイルを確認してください。");
        return;
    }
    
    // --- 実行パラメータ (定数として再定義) ---
    const NETWORK = Network.MAINNET;
    const DECIMALS = 8;
    const APT_MIN_THRESHOLD = 2; // スワップ方向を決定する APTの閾値
    const SLIPPAGE = 0.005; 
    const LOOP_INTERVAL_SECONDS = 5; // ループ間の待機時間 (秒)
    
    const KEEP_APT_AMOUNT_FOR_SWAP = 5; // APT -> kAPT スワップ時に残すAPTの量 (単位: APT)
    const APT_MIN_UNIT_TO_KEEP = KEEP_APT_AMOUNT_FOR_SWAP * (10 ** DECIMALS); 

    // Aptos SDK v2.x 初期化
    const config = new AptosConfig({ network: NETWORK }); 
    const aptos = new Aptos(config);

    // 2. Account 初期化
    const privateKeyBytes = Hex.fromHexInput(PRIVATE_KEY).toUint8Array();
    const privateKeyObject = new Ed25519PrivateKey(privateKeyBytes);
    const signer = Account.fromPrivateKey({ 
        privateKey: privateKeyObject 
    }) as Ed25519Account; 
    const signerAddress = signer.accountAddress.toString();

    // Tapp SDK 初期化
    tappSDK = initTappSDK({
        network: NETWORK,
    });

    let successfulSwaps = 0;
    let failedSwaps = 0;
    let totalAttempts = 0;
    let isAptToKapt = true; // 最初のスワップ方向を設定

    console.log(`--- 自動スワップボット起動: ${signerAddress.slice(0, 8)}... @ ${NETWORK} ---`);
    await sendNotification(`🔄 自動スワップ開始。目標回数: ${SWAP_BATCH_SIZE} 回`);

    while (totalAttempts < SWAP_BATCH_SIZE) {
        totalAttempts++;
        
        try {
            // ----------------------------------------------------
            // 1. APT残高に基づきスワップ方向をチェック＆調整
            // ----------------------------------------------------
            const currentAptBalanceRawUnits = await aptos.getAccountAPTAmount({
                accountAddress: signerAddress,
            });
            const currentAptBalanceDecimal = currentAptBalanceRawUnits / (10 ** DECIMALS);
            
            // APT残高が閾値未満の場合、kAPT -> APT に強制
            if (currentAptBalanceDecimal < APT_MIN_THRESHOLD) {
                isAptToKapt = false;
                console.log(`[方向調整] APT残高 (${currentAptBalanceDecimal.toFixed(4)} APT) < ${APT_MIN_THRESHOLD} APT。kAPT → APT に強制。`);
            } else {
                // APT残高が閾値以上の場合、交互スワップの順番を維持
                // isAptToKapt の値は前のループで反転されている
                console.log(`[方向維持] APT残高 (${currentAptBalanceDecimal.toFixed(4)} APT) >= ${APT_MIN_THRESHOLD} APT。交互スワップを継続。`);
            }
            // ----------------------------------------------------

            // ------------------------------------------
            // 2. スワップ元トークンの残高取得と数量計算
            // ------------------------------------------
            const tokenInType = isAptToKapt ? APT_COIN_TYPE : KAPT_COIN_TYPE;
            
            let currentBalanceInUnits;
            
            if (isAptToKapt) {
                // APTがスワップ元の場合
                currentBalanceInUnits = currentAptBalanceRawUnits;
            } else {
                // kAPTがスワップ元の場合 (utils.ts経由で取得)
                currentBalanceInUnits = await getCoinBalanceInUnits(
                    aptos,
                    signerAddress,
                    tokenInType
                );
            }

            let amountIn;
            let swapDirectionMessage;
            const currentBalanceDecimal = currentBalanceInUnits / (10 ** DECIMALS);

            if (isAptToKapt) {
                // APT -> kPT時、KEEP_APT_AMOUNT_FOR_SWAP分を残す
                amountIn = Math.max(0, currentBalanceInUnits - APT_MIN_UNIT_TO_KEEP);
                swapDirectionMessage = `APT → kAPT (残高: ${currentBalanceDecimal.toFixed(4)} APT, ${KEEP_APT_AMOUNT_FOR_SWAP} APT残し)`;
            } else {
                // kAPT -> APT時、全量をスワップ
                amountIn = currentBalanceInUnits;
                swapDirectionMessage = `kAPT → APT (残高: ${currentBalanceDecimal.toFixed(4)} kAPT, 全量スワップ)`;
            }
            
            console.log(`[計算] ${swapDirectionMessage}. スワップ数量: ${(amountIn / (10 ** DECIMALS)).toFixed(4)}`);

            if (amountIn <= 0) {
                console.log(`スキップ: スワップ可能数量がゼロ以下です。`);
                isAptToKapt = !isAptToKapt; // 方向を反転
                continue; 
            }
            // ------------------------------------------

            // 3. スワップ実行
            const result = await executeTappSwap(
                aptos,
                signer, 
                amountIn,
                SLIPPAGE, 
                isAptToKapt
            );

            await aptos.waitForTransaction({ transactionHash: result.hash });
            
            // 成功後: 次のスワップのために方向を反転
            isAptToKapt = !isAptToKapt;
            successfulSwaps++;
            console.log(`✅ ${successfulSwaps}回目成功。TX: ${result.hash.slice(0, 10)}...`);
            
        } catch (error) {
            failedSwaps++;
            const errorMessage = `❌ スワップ失敗 (${failedSwaps}回目)。エラー: ${(error as Error).message.slice(0, 500)}...`;
            console.error(errorMessage);
            
            isAptToKapt = !isAptToKapt; // 失敗した場合も方向を反転
        }
        
        // ----------------------------------------------------
        // 4. 待機 (残高反映とレート制限対策)
        // ----------------------------------------------------
        console.log(`\n💤 ${LOOP_INTERVAL_SECONDS} 秒間待機します...`);
        await sleep(LOOP_INTERVAL_SECONDS * 1000); 
    }
    
    // 5. 処理完了後のログと通知
    const summaryMessage = `📊 スワップ処理完了 (目標回数: ${SWAP_BATCH_SIZE}回)\n`
                         + `  - 成功回数: ${successfulSwaps}\n`
                         + `  - 失敗回数: ${failedSwaps}`;
                         
    await sendNotification(summaryMessage);
    console.log(`\n${summaryMessage}`);
    
    console.log("--- 自動スワップ処理を終了しました。 ---");
}

main();