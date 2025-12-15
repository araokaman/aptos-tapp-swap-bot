import { Aptos } from "@aptos-labs/ts-sdk";
import type { AccountAddressInput } from "@aptos-labs/ts-sdk"; // 型インポート

/**
 * 特定のコイン残高を整数（最小単位 / Liters）で取得します。
 * Aptos SDK v2の getAccountCoinsData を使用し、asset_type でフィルタリングします。
 * @param aptos Aptosクラスのインスタンス
 * @param accountAddress アカウントアドレス
 * @param coinType コインの型 (例: '0x821c94e69bc7ca058c913b7b5e6b0a5c9fd1523d58723a966fb8c1f5ea888105')
 * @returns 残高 (number, 最小単位)
 */
export async function getCoinBalanceInUnits(
    aptos: Aptos,
    accountAddress: AccountAddressInput,
    coinType: string
): Promise<number> {
    try {
        // 1. アカウントの全コインデータを取得
        const coinsData = await aptos.getAccountCoinsData({
            accountAddress: accountAddress,
        });

        // 2. 取得した配列から、対象の coinType に一致するエントリを探す
        // Aptos SDK の応答に合わせて asset_type (スネークケース) で比較
        const targetCoin = coinsData.find(coin => coin.asset_type === coinType);

        if (targetCoin) {
            // amount は BigInt で返される可能性があるため、Number に変換
            return Number(targetCoin.amount);
        }
        
        return 0; 
        
    } catch (error) {
        // エラーログを削除し、失敗時も 0 を返す (メインロジックの継続のため)
        return 0;
    }
}