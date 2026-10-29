import { AccountCardsPanel } from '../counterparty/AccountCardsPanel.jsx';
import { TimingContractsPanel } from './TimingContractsPanel.jsx';
import { useEffect, useState } from 'react';
import { profileDefinition } from '../../../shared/product.js';
import { TransactionsPanel } from './TransactionsPanel.jsx';
import { ObligationsPanel } from './ObligationsPanel.jsx';
import ChequesPanel from './ChequesPanel.jsx';
import { GuaranteeCheques } from './GuaranteeCheques.jsx';
import { InvoicesPanel } from './InvoicesPanel.jsx';
import { ReconciliationPanel } from './ReconciliationPanel.jsx';
import { RecurringPanel } from './RecurringPanel.jsx';
import { InventoryPanel } from './InventoryPanel.jsx';
import { ToolsPanel } from './ToolsPanel.jsx';

export function LedgerPage({ profileType = 'business', categories, accounts = [], contacts: initialContacts, notify, refresh, initialTab = 'transactions', cardSection = '', onTabChange, navigate = null }) {
  const [tab, setTab] = useState(initialTab);
  const profile = profileDefinition(profileType);
  const allTabs = [['transactions', profileType === 'personal' ? 'ثبت‌ها' : 'تراکنش‌ها'], ['obligations', profileType === 'personal' ? 'قسط و بدهی' : 'طلب و بدهی'], ['cheques', 'چک‌ها'], ['timing', 'پیش‌پرداخت و پیش‌دریافت'], ['counterparties', 'کارت حساب'], ['invoices', 'فاکتور'], ['reconciliation', 'تطبیق بانک'], ['recurring', 'دوره‌ای'], ['inventory', 'موجودی'], ['tools', 'ابزارها']];
  const tabs = allTabs.filter(([id]) => profile.ledgerTabs.includes(id));
  useEffect(() => { if (profile.ledgerTabs.includes(initialTab)) setTab(initialTab); }, [initialTab, profileType]);
  useEffect(() => { if (!profile.ledgerTabs.includes(tab)) setTab('transactions'); }, [profile, tab]);
  return <main className="mx-auto w-full max-w-[980px] px-4 py-5"><div className="flex items-center justify-between"><div><h1 className="text-xl font-extrabold">دفتر مالی</h1><p className="mt-1 text-[13px] text-muted">{profile.description}</p></div></div><nav aria-label="بخش‌های دفتر مالی" className="section-navigation">{tabs.map(([id, label]) => <button key={id} type="button" aria-current={tab === id ? 'page' : undefined} onClick={() => { setTab(id); onTabChange?.(id); }}>{label}</button>)}</nav>{tab === 'transactions' && <TransactionsPanel categories={categories} accounts={accounts} contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'obligations' && <ObligationsPanel contacts={initialContacts} notify={notify} refresh={refresh} />}{tab === 'cheques' && <section className="mt-5"><ChequesPanel contacts={initialContacts} notify={notify} refresh={refresh} /><GuaranteeCheques /></section>}{tab === 'timing' && <TimingContractsPanel notify={notify} />}{tab === 'counterparties' && <AccountCardsPanel accounts={accounts} contacts={initialContacts} notify={notify} refresh={refresh} initialSection={cardSection} pettyAvailable={profileType === 'business'} onNewPetty={navigate ? () => navigate('petty-cash', 'new') : null} />}{tab === 'invoices' && <InvoicesPanel contacts={initialContacts} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'reconciliation' && <ReconciliationPanel accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}{tab === 'recurring' && <RecurringPanel categories={categories} notify={notify} />}{tab === 'inventory' && <InventoryPanel notify={notify} />}{tab === 'tools' && <ToolsPanel profileType={profileType} accounts={accounts} categories={categories} notify={notify} refresh={refresh} />}</main>;
}
