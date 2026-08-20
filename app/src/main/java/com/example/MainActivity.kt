package com.example

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.example.data.model.DocumentEntity
import com.example.ui.components.*
import com.example.ui.screens.*
import com.example.ui.theme.HesabYarTheme
import com.example.ui.viewmodel.HesabYarViewModel
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {

    private val viewModel: HesabYarViewModel by viewModels()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()
        setContent {
            HesabYarTheme {
                HesabYarApp(viewModel = viewModel)
            }
        }
    }
}

@Composable
fun HesabYarApp(viewModel: HesabYarViewModel) {
    val drawerState = rememberDrawerState(initialValue = DrawerValue.Closed)
    val scope = rememberCoroutineScope()
    val snackbarHostState = remember { SnackbarHostState() }

    var currentScreen by remember { mutableStateOf(NavigationScreen.FAST_ENTRY) }

    val activeCompany by viewModel.activeCompany.collectAsState()
    val allCompanies by viewModel.allCompanies.collectAsState()
    val documents by viewModel.documents.collectAsState()
    val transactions by viewModel.transactions.collectAsState()
    val contacts by viewModel.contacts.collectAsState()
    val categories by viewModel.categories.collectAsState()
    val bankAccounts by viewModel.bankAccounts.collectAsState()
    val bankTransactions by viewModel.bankTransactions.collectAsState()
    val rules by viewModel.rules.collectAsState()

    val userRole by viewModel.userRole.collectAsState()
    val accountPlan by viewModel.accountPlan.collectAsState()

    val saveSuccessMsg by viewModel.saveSuccessMessage.collectAsState()
    LaunchedEffect(saveSuccessMsg) {
        saveSuccessMsg?.let { msg ->
            snackbarHostState.showSnackbar(msg)
            viewModel.dismissSuccessMessage()
        }
    }

    var showCreateCompanyDialog by remember { mutableStateOf(false) }
    var showAIAssistantSheet by remember { mutableStateOf(false) }
    var selectedDocumentForModal by remember { mutableStateOf<DocumentEntity?>(null) }

    ModalNavigationDrawer(
        drawerState = drawerState,
        drawerContent = {
            HesabYarDrawerContent(
                currentScreen = currentScreen,
                onSelectScreen = { currentScreen = it },
                activeCompany = activeCompany,
                userRole = userRole,
                onCloseDrawer = { scope.launch { drawerState.close() } }
            )
        }
    ) {
        Scaffold(
            snackbarHost = { SnackbarHost(snackbarHostState) },
            topBar = {
                HesabYarTopAppBar(
                    activeCompany = activeCompany,
                    companies = allCompanies,
                    userRole = userRole,
                    onSelectCompany = { viewModel.switchCompany(it) },
                    onCreateNewCompany = { showCreateCompanyDialog = true },
                    onOpenDrawer = { scope.launch { drawerState.open() } },
                    onOpenAIChat = { showAIAssistantSheet = true }
                )
            }
        ) { paddingValues ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(paddingValues)
            ) {
                when (currentScreen) {
                    NavigationScreen.FAST_ENTRY -> {
                        FastEntryScreen(
                            viewModel = viewModel,
                            onNavigateToDocuments = { currentScreen = NavigationScreen.DOCUMENTS }
                        )
                    }

                    NavigationScreen.DASHBOARD -> {
                        DashboardScreen(
                            documents = documents,
                            transactions = transactions,
                            bankAccounts = bankAccounts,
                            activeCompany = activeCompany,
                            onNavigateToFastEntry = { currentScreen = NavigationScreen.FAST_ENTRY },
                            onNavigateToDocuments = { currentScreen = NavigationScreen.DOCUMENTS },
                            onSelectDocument = { selectedDocumentForModal = it }
                        )
                    }

                    NavigationScreen.DOCUMENTS -> {
                        DocumentsScreen(
                            documents = documents,
                            onSelectDocument = { selectedDocumentForModal = it },
                            onAddNewDocument = { currentScreen = NavigationScreen.FAST_ENTRY }
                        )
                    }

                    NavigationScreen.TRANSACTIONS -> {
                        TransactionsScreen(
                            transactions = transactions,
                            onAddTransaction = { type, amount, contact, desc, cat ->
                                viewModel.addTransaction(type, amount, contact, desc, cat)
                            }
                        )
                    }

                    NavigationScreen.CONTACTS -> {
                        ContactsScreen(
                            contacts = contacts,
                            documents = documents,
                            onAddContact = { name, phone, type, notes ->
                                viewModel.addContact(name, phone, type, notes)
                            }
                        )
                    }

                    NavigationScreen.CATEGORIES -> {
                        CategoriesScreen(
                            categories = categories,
                            documents = documents,
                            rules = rules,
                            onAddRule = { kw, cat -> viewModel.addRule(kw, cat) }
                        )
                    }

                    NavigationScreen.BANKS -> {
                        BanksScreen(
                            bankAccounts = bankAccounts,
                            bankTransactions = bankTransactions,
                            documents = documents,
                            onMatchTransaction = { bankTransId, docId ->
                                viewModel.reconcileBank(bankTransId, docId)
                            }
                        )
                    }

                    NavigationScreen.REPORTS -> {
                        ReportsScreen(
                            documents = documents,
                            transactions = transactions,
                            activeCompany = activeCompany
                        )
                    }

                    NavigationScreen.EXPORT -> {
                        ExportScreen(
                            documents = documents,
                            activeCompany = activeCompany
                        )
                    }

                    NavigationScreen.SETTINGS -> {
                        SettingsScreen(
                            activeCompany = activeCompany,
                            userRole = userRole,
                            accountPlan = accountPlan,
                            onRoleChange = { viewModel.setUserRole(it) },
                            onPlanChange = { viewModel.setAccountPlan(it) }
                        )
                    }
                }
            }
        }
    }

    // Dialogs & Sheets
    if (showCreateCompanyDialog) {
        CreateCompanyDialog(
            onDismiss = { showCreateCompanyDialog = false },
            onConfirm = { name, activity, nationalId, city, desc ->
                viewModel.createCompany(name, activity, nationalId, city, desc)
            }
        )
    }

    if (showAIAssistantSheet) {
        AIAssistantSheet(
            activeCompany = activeCompany,
            documents = documents,
            transactions = transactions,
            onDismiss = { showAIAssistantSheet = false }
        )
    }

    selectedDocumentForModal?.let { doc ->
        val auditLogs by viewModel.repository.getAuditLogs(doc.id).collectAsState(initial = emptyList())
        DocumentDetailModal(
            document = doc,
            auditLogs = auditLogs,
            onClose = { selectedDocumentForModal = null },
            onStatusChange = { newStatus ->
                viewModel.updateDocumentStatus(doc.id, newStatus)
                selectedDocumentForModal = null
            }
        )
    }
}
