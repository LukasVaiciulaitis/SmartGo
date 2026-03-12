package com.example.smartgoprototype.ui.editroute

import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.hilt.navigation.compose.hiltViewModel

@Composable
fun EditRouteRoute(
    onBack: () -> Unit,
    onSaved: () -> Unit,
    viewModel: EditRouteViewModel = hiltViewModel()
) {
    val uiState by viewModel.uiState.collectAsState()

    EditRouteScreen(
        uiState = uiState,
        onBack = onBack,
        onTitleChange = viewModel::onTitleChange,
        onTravelModeSelected = viewModel::onTravelModeSelected,
        onArriveByChange = viewModel::onArriveByChange,
        onToggleDay = viewModel::toggleDay,
        onSave = { viewModel.save(onSaved) }
    )
}
