package com.example.smartgoprototype.ui.register

import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.hilt.lifecycle.viewmodel.compose.hiltViewModel

@Composable
fun ConfirmSignUpRoute(
    username: String,
    viewModel: ConfirmSignUpViewModel = hiltViewModel(),
    onConfirmSuccess: () -> Unit = {},
    onBackToLogin: () -> Unit = {}
) {
    // Inject username into VM once
    LaunchedEffect(username) {
        viewModel.initUsername(username)
    }

    val uiState = viewModel.uiState

    LaunchedEffect(uiState.isSuccess) {
        if (uiState.isSuccess) {
            onConfirmSuccess()
        }
    }

    ConfirmSignUpScreen(
        uiState = uiState,
        onCodeChanged = viewModel::onCodeChanged,
        onConfirmClicked = viewModel::onConfirmClicked,
        onBackToLogin = onBackToLogin
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConfirmSignUpScreen(
    uiState: ConfirmSignUpUiState,
    onCodeChanged: (String) -> Unit,
    onConfirmClicked: () -> Unit,
    onBackToLogin: () -> Unit
) {
    Scaffold { paddingValues ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .padding(horizontal = 24.dp),
            contentAlignment = Alignment.Center
        ) {
            Column(
                modifier = Modifier.fillMaxWidth(),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Verify your email",
                    style = MaterialTheme.typography.headlineMedium,
                    modifier = Modifier.padding(bottom = 8.dp)
                )

                Text(
                    text = "We sent a 6-digit code to your email.\nAccount: ${uiState.username}",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = 24.dp)
                )

                OutlinedTextField(
                    value = uiState.code,
                    onValueChange = onCodeChanged,
                    label = { Text("Verification code") },
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(bottom = 8.dp),
                    singleLine = true,
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(
                        keyboardType = KeyboardType.Number
                    )
                )

                uiState.errorMessage?.let { error ->
                    Text(
                        text = error,
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodySmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp)
                    )
                }

                Button(
                    onClick = onConfirmClicked,
                    enabled = !uiState.isLoading,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(48.dp)
                ) {
                    if (uiState.isLoading) {
                        CircularProgressIndicator(
                            strokeWidth = 2.dp,
                            modifier = Modifier.size(20.dp)
                        )
                    } else {
                        Text("Confirm")
                    }
                }

                TextButton(
                    onClick = onBackToLogin,
                    modifier = Modifier.padding(top = 16.dp)
                ) {
                    Text("Back to login")
                }
            }
        }
    }
}
