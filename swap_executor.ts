import * as dotenv from 'dotenv';
// Aptos SDK v2.x 厳格型対応のインポート
import { 
    Aptos, 
    Account, 
    Network, 
    AptosConfig, 
    Ed25519Account,
    Ed25519PrivateKey,
    TransactionPayload, 
    Hex, // Hex クラスをインポート
} from "@aptos-labs/ts-sdk";
import type { PendingTransactionResponse } from "@aptos-labs/ts-sdk"; // 型インポート

import { initTappSDK } from "@tapp-exchange/sdk"; 
import { sendNotification } from './notification.js'; // モジュール解決のため .js 拡張子を使用

dotenv.config();

// --- 環境変数の読み込み ---
const NODE_URL = process.env.APTOS_NODE_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY; // string
const SWAP_BATCH_SIZE = parseInt(process.env.SWAP_BATCH_SIZE || '50', 10); 
const TAPP_POOL_ID = process.env.TAPP_POOL_ID;
const TOKEN_INDEX_APT = parseInt(process.env.TOKEN_IN_INDEX_APT || '0', 10);
const TOKEN_INDEX_KAPT = parseInt(process.env.TOKEN_IN_INDEX_KAPT || '1', 10);

// Tapp SDKの型はstringで代用 (アドレスはstring)
type CoinAddress = string; 
const APT_COIN_ADDRESS: CoinAddress = "0x1::aptos_coin::AptosCoin";
const KAPT_TOKEN_ADDRESS: CoinAddress = "0x821c94e69bc7ca058c913b7b5e6b0a5c9fd1523d58723a966fb8c1f5ea888105";

// Tapp SDK のインスタンスを保持する変数
let tappSDK: ReturnType<typeof initTappSDK>;


/**
 * Tapp SDKのStable Swapを使用してスワップを実行します。
 * @param aptos Aptosクラスのインスタンス
 * @param signer トランザクションを署名するアカウント
 * @param amountIn スワップする正確な量（数値型、最小単位）
 * @param slippage 許容するスリッページ率 (例: 0.005 = 0.5%)
 * @param fromTokenIn APTを支払う場合は true (APT -> kAPT), false (kAPT -> APT)
 * @returns PendingTransactionResponse 提出されたトランザクションのハッシュを含むオブジェクト
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
    
    // 3. Build: Tappのペイロードを Aptos の Raw Transaction に変換
    const rawTransaction = await aptos.transaction.build.simple({
        sender: signer.accountAddress, 
        data: tappPayload,
    });

    // 4. Sign: トランザクションに署名
    const senderAuthenticator = aptos.transaction.sign({
        signer: signer,
        transaction: rawTransaction, 
    });
    
    // 5. Submit: 署名済みトランザクションを提出
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
    if (!NODE_URL || !PRIVATE_KEY || !TAPP_POOL_ID) {
        await sendNotification("🚨 設定エラー: NODE_URL, PRIVATE_KEY, TAPP_POOL_ID のいずれかが設定されていません。");
        console.error("設定エラー: .env ファイルを確認してください。");
        return;
    }
    
    // Aptos SDK v2.x 初期化
    const aptosConfig = new AptosConfig({ 
        fullnode: NODE_URL, 
        network: Network.MAINNET 
    });
    const aptos = new Aptos(aptosConfig);
    
    // 2. Account 初期化
    if (typeof PRIVATE_KEY !== 'string') {
        throw new Error("PRIVATE_KEY must be a string.");
    }
    
    // 🚨 修正箇所: Hex.fromHexInput を使用して string を Hex オブジェクトとして正しく処理
    const privateKeyBytes = Hex.fromHexInput(PRIVATE_KEY).toUint8Array();
    const privateKeyObject = new Ed25519PrivateKey(privateKeyBytes); // 公式ドキュメントの記述に合わせる
    
    const signer = Account.fromPrivateKey({ 
        privateKey: privateKeyObject 
    }) as Ed25519Account; 

    // Tapp SDK 初期化
    tappSDK = initTappSDK({
        network: Network.MAINNET,
        url: NODE_URL 
    });

    // --- 実行パラメータ ---
    const APT_IN_DECIMAL = 0.01; 
    const DECIMALS = 8;
    const SLIPPAGE = 0.005; 
    const amountInNumber = Math.floor(APT_IN_DECIMAL * (10 ** DECIMALS)); 

    let successfulSwaps = 0;
    let failedSwaps = 0;
    let totalAttempts = 0;
    let running = true; 

    console.log(`--- 自動スワップボット起動 ---`);
    await sendNotification(`🔄 自動スワップ開始。バッチサイズ: ${SWAP_BATCH_SIZE} 回`);

    while (running) {
        totalAttempts++;
        let currentBatchSwaps = 0;
        
        while (currentBatchSwaps < SWAP_BATCH_SIZE) {
            currentBatchSwaps++;
            
            console.log(`\n[${totalAttempts + currentBatchSwaps - 1}回目] スワップ試行中...`);
            
            try {
                const result = await executeTappSwap(
                    aptos,
                    signer, 
                    amountInNumber, 
                    SLIPPAGE, 
                    true 
                );

                await aptos.waitForTransaction({ transactionHash: result.hash });

                successfulSwaps++;
                console.log(`✅ ${successfulSwaps}回目成功。ハッシュ: ${result.hash.slice(0, 10)}...`);
                
            } catch (error) {
                failedSwaps++;
                const errorMessage = `❌ スワップ失敗 (${failedSwaps}回目)。エラー: ${(error as Error).message.slice(0, 100)}...`;
                console.error(errorMessage);
            }
        }
        
        const summaryMessage = `📊 バッチ完了通知 (総試行回数: ${totalAttempts}回)\n`
                             + `  - 成功回数: ${successfulSwaps}\n`
                             + `  - 失敗回数: ${failedSwaps}\n`
                             + `  - 次のバッチを開始するには、スクリプトを再実行してください。`;
                             
        await sendNotification(summaryMessage);
        console.log(`\n${summaryMessage}`);
        
        running = false; 
        console.log("--- スワップ処理を一時停止しました。試算の確認をお願いします。 ---");
    }
}

main();